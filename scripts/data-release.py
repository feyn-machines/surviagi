#!/usr/bin/env python3
"""Import the published snapshot as a versioned release, activate it, roll it back.

    release   store datasets/published/latest/ as a verified release (not live)
    promote   make the newest verified release live
    rollback  make the previously live release live again
    status    list releases and the live one
    reset     drop and recreate the kg schema (destroys all releases; --target local only)
    setup-db  create or update the server database, its roles and the kg schema (--target server only)

`rollback` re-activates the previously active release, so running it twice
returns to where you started.

`--target server` runs the same commands against the server database through an
SSH forward (settings in .env.deploy; the writer's password is read from the
server into memory). After `promote` and `rollback` it reports what the
production site serves and, once it serves the new release, tells IndexNow
which addresses are new, changed or gone since the sitemap it last accepted.
`--target local` (the default) is the local database.
Errors are one `error: ...` line and exit status 1.
"""
import argparse
import contextlib
from pathlib import Path
import signal
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))

import psycopg  # noqa: E402

import server_db  # noqa: E402
from data_pipeline import kg  # noqa: E402
from data_pipeline.db import connect  # noqa: E402
import site_release  # noqa: E402
from site_release import ReleaseError  # noqa: E402


def open_target(target, clear_orphans: bool = False):
    """A connection to the release database; `clear_orphans` ends what a stopped attempt left locked."""
    if target == "local":
        return connect()

    @contextlib.contextmanager
    def server():
        with server_db.server_connection() as conn:
            ended = server_db.clear_orphan_release_sessions(conn) if clear_orphans else []
            if ended:
                print(f"ended {len(ended)} release session(s) an earlier attempt left holding the release lock")
            yield conn

    return server()


def summarize(changes):
    lines = []
    for name, c in changes.items():
        if c["added"] or c["changed"] or c["removed"]:
            lines.append(f"  {name}: +{c['added']} ~{c['changed']} -{c['removed']}" + (" order changed" if c["reordered"] else ""))
        elif c["reordered"]:
            lines.append(f"  {name}: order changed")
    return lines or ["  no rows differ from the active release"]


def cmd_release(conn, args):
    payload, manifest = kg.read_snapshot(args.snapshot)
    started = time.monotonic()
    kg.ensure_schema(conn)
    before = kg.active_seq(conn)
    result = kg.import_release(conn, payload, manifest)
    elapsed = time.monotonic() - started
    if not result.created:
        print(f"release {result.release_id} is already imported; nothing new ({elapsed:.1f}s)")
        return
    print(f"release {result.release_id} imported and verified: {result.docs_written} new documents ({elapsed:.1f}s)")
    label = "the active release" if before is not None else "nothing (no active release)"
    print(f"changes against {label}:")
    print("\n".join(summarize(kg.diff(conn, result.seq, before))))
    print("not live yet; run `promote` to make it live")


def cmd_promote(conn, args):
    kg.ensure_schema(conn)
    verified = [r for r in kg.status(conn)["releases"] if r["status"] == "verified"]
    if not verified:
        raise kg.KgError("no verified release to promote; run `release` first")
    kg.activate(conn, verified[0]["release_id"], "promote")
    print(f"active release: {verified[0]['release_id']}")
    return verified[0]["release_id"]


def cmd_rollback(conn, args):
    active = kg.rollback(conn)
    print(f"active release: {active}")
    return active


def cmd_status(conn, args):
    kg.ensure_schema(conn)
    info = kg.status(conn)
    print(f"active: {info['active'] or 'none'}")
    for r in info["releases"]:
        mark = "*" if r["release_id"] == info["active"] else " "
        total = sum((r["counts"] or {}).values())
        print(f"{mark} {r['release_id']}  {r['status']}  {total} rows  imported {r['imported_at']}")
    if not info["releases"]:
        print("no releases")
    if args.target == "server":
        server_db.report_production()


def cmd_reset(conn, args):
    kg.reset(conn)
    print("kg schema recreated empty")


COMMANDS = {"release": cmd_release, "promote": cmd_promote, "rollback": cmd_rollback, "status": cmd_status,
            "reset": cmd_reset}
SERVER_ONLY = {"setup-db"}
# After these the production site is asked which data release it serves, and IndexNow hears what changed
# once it serves it (server target only).
WATCHED = {"promote", "rollback"}
SERVER_OPERATION_TIMEOUT = 300


@contextlib.contextmanager
def operation_timeout(seconds: int):
    """Bound a server transaction so a lossy SSH/COPY stream cannot occupy the daily run forever."""
    if not hasattr(signal, "SIGALRM"):
        yield
        return
    previous = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, lambda _signum, _frame: (_ for _ in ()).throw(
        ReleaseError(f"server database operation exceeded {seconds}s; SSH/COPY stream stalled")))
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


# Commands that take the release advisory lock: an earlier attempt's dead session would block them.
LOCKING = {"release", "promote", "rollback"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=sorted([*COMMANDS, *SERVER_ONLY]))
    parser.add_argument("--target", choices=("local", "server"), default="local")
    parser.add_argument("--snapshot", type=Path, default=kg.SNAPSHOT_DIR)
    args = parser.parse_args(argv)
    try:
        if args.command == "reset" and args.target != "local":
            raise kg.KgError("reset works only with --target local")
        if args.command in SERVER_ONLY:
            if args.target != "server":
                raise kg.KgError(f"{args.command} works only with --target server")
            server_db.setup_db()
            return 0
        with operation_timeout(SERVER_OPERATION_TIMEOUT if args.target == "server" else 0):
            with open_target(args.target, clear_orphans=args.command in LOCKING) as conn:
                result = COMMANDS[args.command](conn, args)
        if args.target == "server" and args.command in WATCHED and server_db.report_production(result):
            site_release.notify_indexnow(only_changed=True)
    except ReleaseError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        print(f"error: a command on the server failed with status {error.returncode}", file=sys.stderr)
        return 1
    except psycopg.Error as error:
        print(f"error: {server_db.first_line(error)}", file=sys.stderr)
        return 1
    except (kg.KgError, psycopg.Error, RuntimeError, OSError, ValueError) as error:
        print(f"error: {' '.join(str(error).split())}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
