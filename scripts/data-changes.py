#!/usr/bin/env python3
"""Write what changed between two published data releases, as material for an article.

    pnpm data:changes                          the previously live local release -> the live one
    pnpm data:changes --from <id> --to <id>    any two releases in the local database
    pnpm data:changes --to datasets/published/latest
                                               a snapshot directory not yet released

A release is a release id in the local database (`pnpm data:local:release`) or a
directory holding a snapshot (manifest.json and its files). The brief is written to
data/reports/changes-<from>_<to>.md (local, ignored) unless --output says otherwise.
Read-only: nothing is written to any database, and the server is never contacted.
Errors are one `error: ...` line and exit status 1.
"""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

import psycopg  # noqa: E402

from data_pipeline import changes, kg  # noqa: E402
from data_pipeline.db import connect  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "data" / "reports"


def previous_live(conn, active_seq):
    """The release that was live before the active one; failing that, the newest older release."""
    rows = conn.execute("SELECT r.release_id, a.release_seq FROM kg.activations a "
                        "JOIN kg.releases r ON r.seq = a.release_seq ORDER BY a.id DESC").fetchall()
    for row in rows:
        if row["release_seq"] != active_seq:
            return row["release_id"]
    row = conn.execute("SELECT release_id FROM kg.releases WHERE seq < %s AND status = 'verified' "
                       "ORDER BY seq DESC LIMIT 1", (active_seq,)).fetchone()
    return row["release_id"] if row else None


def load(conn, ref):
    """(label, payload) for a release id or a snapshot directory."""
    path = Path(ref)
    if (path / "manifest.json").is_file():
        payload, manifest = kg.read_snapshot(path)
        return kg.release_id(manifest), payload
    row = conn.execute("SELECT seq FROM kg.releases WHERE release_id = %s", (ref,)).fetchone()
    if row is None:
        raise kg.KgError(f"no release {ref} in the local database, and no snapshot directory there")
    return ref, kg.load_release(conn, row["seq"])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="old", help="release id or snapshot directory (default: the previously live one)")
    parser.add_argument("--to", dest="new", help="release id or snapshot directory (default: the live one)")
    parser.add_argument("--output", type=Path, help="where to write the brief (default: data/reports/changes-<from>_<to>.md)")
    args = parser.parse_args(argv)
    try:
        with connect() as conn:
            new_ref = args.new
            if new_ref is None:
                info = kg.status(conn)
                if not info["active"]:
                    raise kg.KgError("no live local release; pass --to")
                new_ref = info["active"]
            old_ref = args.old
            if old_ref is None:
                active = kg.active_seq(conn)
                old_ref = previous_live(conn, active) if active is not None else None
                if old_ref is None:
                    raise kg.KgError("no earlier release to compare with; pass --from")
            old_id, old = load(conn, old_ref)
            new_id, new = load(conn, new_ref)
        if old_id == new_id:
            raise kg.KgError(f"--from and --to are the same release ({old_id})")
        text = changes.render(changes.compare(old, new), old_id, new_id)
        output = args.output or REPORTS / f"changes-{old_id}_{new_id}.md"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text)
        print(f"wrote {output}")
    except (kg.KgError, psycopg.Error, RuntimeError, OSError, ValueError) as error:
        print(f"error: {' '.join(str(error).split())}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
