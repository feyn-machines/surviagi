"""Schema `app` (user data): applying it, setting it up locally, pulling approved submissions.

The schema belongs to role oaw_app. The role and the schema itself are created by a superuser
(here for the local database; by deploy/db/roles.sql on the server); the tables are created by oaw_app.
Passwords are passed as query parameters or through the environment, never formatted into SQL text.

No psycopg import at module level: the pure helpers are unit-tested with the system python."""
from __future__ import annotations

import json
import os
import re
import secrets
import stat
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_ROLE = "oaw_app"
APP_SQL = sorted((ROOT / "db/app").glob("*.sql"))
PASSWORD_FILE = ROOT / "data/postgres/app-password"
ENV_FILES = (ROOT / ".env", ROOT / ".env.local")
LOCAL_DATABASE = "openaiwill_local"
SUBMISSIONS_DIR = ROOT / "data/submissions"
VOTES_DIR = ROOT / "data/votes"


class AppError(Exception):
    """A problem the operator can act on; the command line prints it as one line."""


def apply_schema(conn) -> None:
    """Apply db/app/*.sql in one transaction. `conn` is a connection as the schema's owner."""
    with conn.transaction():
        for path in APP_SQL:
            conn.execute(path.read_text())


# Object kinds already in schema app whose owner must be the app role, and the
# keyword ALTER ... OWNER TO needs for each. Indexes follow their table; identity
# and serial sequences do too, and PostgreSQL refuses to change those directly.
SCHEMA_OBJECT_KINDS = {"r": "TABLE", "p": "TABLE", "v": "VIEW", "m": "MATERIALIZED VIEW",
                       "f": "FOREIGN TABLE"}
# A sequence no table owns needs its own ALTER; one a table owns is skipped here.
UNOWNED_SEQUENCES = (
    "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
    "WHERE n.nspname = %s AND c.relkind = 'S' AND NOT EXISTS ("
    "  SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid "
    "  AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i'))")


def adopt_schema_objects(admin_conn, role: str, schema: str = "app") -> None:
    """Give `role` ownership of everything already in `schema`.

    A database restored from a dump can already hold schema app with its tables owned by the
    restoring role; the app role then cannot apply db/app/*.sql, because CREATE INDEX IF NOT
    EXISTS still checks ownership of the table and fails with "must be owner of table". Runs as
    a superuser: the local admin connection is one."""
    from psycopg import sql

    for row in admin_conn.execute(
            "SELECT c.relkind, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = %s AND c.relkind = ANY(%s)",
            (schema, list(SCHEMA_OBJECT_KINDS))).fetchall():
        admin_conn.execute(sql.SQL("ALTER {} {}.{} OWNER TO {}").format(
            sql.SQL(SCHEMA_OBJECT_KINDS[row["relkind"]]), sql.Identifier(schema),
            sql.Identifier(row["relname"]), sql.Identifier(role)))
    for row in admin_conn.execute(UNOWNED_SEQUENCES, (schema,)).fetchall():
        admin_conn.execute(sql.SQL("ALTER SEQUENCE {}.{} OWNER TO {}").format(
            sql.Identifier(schema), sql.Identifier(row["relname"]), sql.Identifier(role)))
    for row in admin_conn.execute(
            "SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p "
            "JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = %s", (schema,)).fetchall():
        admin_conn.execute(sql.SQL("ALTER FUNCTION {}.{}({}) OWNER TO {}").format(
            sql.Identifier(schema), sql.Identifier(row["proname"]), sql.SQL(row["args"]), sql.Identifier(role)))


def ensure_role_and_schema(admin_conn, password: str, role: str = APP_ROLE) -> None:
    """Create the role if absent, set its password and limits, and create schema app owned by it."""
    from psycopg import sql

    name = sql.Identifier(role)
    exists = admin_conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,)).fetchone()
    if not exists:
        admin_conn.execute(sql.SQL("CREATE ROLE {} LOGIN").format(name))
    admin_conn.execute(sql.SQL("ALTER ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD {}").format(
        name, sql.Literal(password)))
    admin_conn.execute(sql.SQL("ALTER ROLE {} SET search_path = app").format(name))
    database = admin_conn.execute("SELECT current_database() AS name").fetchone()["name"]
    admin_conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(sql.Identifier(database), name))
    admin_conn.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION {}").format(name))
    admin_conn.execute(sql.SQL("ALTER SCHEMA app OWNER TO {}").format(name))
    # A restored database has schema app already, with its objects owned by whoever restored it.
    adopt_schema_objects(admin_conn, role)


def _write_atomic(path: Path, text: str) -> None:
    """Write `text` to `path` through a mode-0600 temp file in the same directory, then replace."""
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def local_password(path: Path | None = None) -> str:
    """The local oaw_app password, created on first use in an ignored file with mode 0600."""
    path = PASSWORD_FILE if path is None else Path(path)
    if not path.is_symlink() and not path.exists():
        _write_atomic(path, secrets.token_hex(24))
    if path.is_symlink() or not path.is_file():
        raise AppError("The local app password file must be a regular file, not a link")
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise AppError("The local app password file must have mode 0600")
    value = path.read_text().strip()
    if not value:
        raise AppError("The local app password file is empty")
    return value


def connect_app(database: str | None = None):
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(
        host="127.0.0.1", port=7543, dbname=LOCAL_DATABASE if database is None else database,
        user=APP_ROLE, password=local_password(), autocommit=True, row_factory=dict_row,
        connect_timeout=5, application_name="openaiwill-app", options="-c timezone=UTC")


def _env_line(line: str) -> tuple[str, str] | None:
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        return None
    key, value = line.split("=", 1)
    return key.strip(), value.strip()


def read_env_value(key: str, paths=ENV_FILES) -> str | None:
    """The value of one KEY in the given env files (later file wins), scanning line by line.
    A value wrapped in matching quotes loses them. Nothing else is kept in memory."""
    found = None
    for path in paths:
        if not Path(path).is_file():
            continue
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                pair = _env_line(line)
                if pair and pair[0] == key:
                    value = pair[1]
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                        value = value[1:-1]
                    found = value
    return found


def read_admin_emails(paths=ENV_FILES) -> list[str]:
    """Administrator addresses from ADMIN_EMAILS: trimmed, lower-cased, de-duplicated, without '@'-less entries."""
    emails: list[str] = []
    for entry in (read_env_value("ADMIN_EMAILS", paths) or "").split(","):
        entry = entry.strip().lower()
        if "@" in entry[1:] and entry not in emails:
            emails.append(entry)
    return emails


def sync_admins(conn, emails: list[str]) -> tuple[int, int]:
    """Make app.admins equal to `emails` in one transaction; return (added, removed)."""
    wanted = sorted({e.strip().lower() for e in emails if e.strip()})
    if not wanted:
        raise AppError("ADMIN_EMAILS is empty; the administrator list was left unchanged")
    with conn.transaction():
        removed = conn.execute("DELETE FROM app.admins WHERE email <> ALL(%s) RETURNING email", (wanted,)).fetchall()
        added = conn.execute(
            "INSERT INTO app.admins (email) SELECT unnest(%s::text[]) ON CONFLICT DO NOTHING RETURNING email",
            (wanted,)).fetchall()
    return len(added), len(removed)


def write_env_local(values: dict[str, str], path: Path | None = None) -> None:
    """Replace KEY= lines in place, append missing keys, keep every other line, mode 0600."""
    path = ROOT / ".env.local" if path is None else Path(path)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pending = dict(values)
    for index, line in enumerate(lines):
        exported = line.lstrip().startswith("export ")
        pair = _env_line(line.lstrip()[7:] if exported else line)
        if pair and pair[0] in pending:
            lines[index] = f"{'export ' if exported else ''}{pair[0]}={pending.pop(pair[0])}"
    lines.extend(f"{key}={value}" for key, value in pending.items())
    _write_atomic(path, "\n".join(lines) + "\n")


def setup_local() -> None:
    """Create role and schema in the local working database, apply the tables, sync administrators, update .env.local."""
    from data_pipeline.db import connect

    password = local_password()
    with connect() as admin:
        ensure_role_and_schema(admin, password)
    with connect_app() as conn:
        apply_schema(conn)
        emails = read_admin_emails()
        if emails:
            added, removed = sync_admins(conn, emails)
            print(f"administrators: {len(emails)} on the list (+{added}, -{removed})")
        else:
            print("administrators: ADMIN_EMAILS is empty; the list in the database was left unchanged")
    values = {
        "APP_DATABASE_URL": f"postgres://{APP_ROLE}:{password}@127.0.0.1:7543/{LOCAL_DATABASE}",
        "BETTER_AUTH_URL": "http://localhost:3456",
    }
    if not read_env_value("BETTER_AUTH_SECRET", (ROOT / ".env.local",)):
        values["BETTER_AUTH_SECRET"] = secrets.token_hex(32)
    write_env_local(values)
    print("app schema ready in the local database; .env.local updated (values not shown)")


def _pull_accounts(rows) -> list[dict]:
    """Approved, not yet imported submission rows (ordered by created_at, id) grouped by account. The display
    handle is the earliest request's; `approved_at` is when the account was first approved. No requester data."""
    groups: dict[tuple[str, str], dict] = {}
    for row in rows:
        group = groups.setdefault((row["handle"], row["owner_kind"]), {
            "handle": row["display_handle"], "account_kind": row["owner_kind"], "requests": 0, "notes": [],
            "approved_at": row["decided_at"]})
        group["requests"] += 1
        if row["note"]:
            group["notes"].append(row["note"])
        if row["decided_at"] < group["approved_at"]:
            group["approved_at"] = row["decided_at"]
    accounts = list(groups.values())
    for account in accounts:
        account["approved_at"] = account["approved_at"].astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return accounts


def _write_exclusive(directory: Path, stem: str, text: str) -> Path:
    """Write `text` to directory/<stem>.json, or <stem>-1.json, -2 ... when that name exists: the content goes to
    a private temp file first and is hard-linked under the final name, which fails instead of replacing."""
    tmp = directory / f".{stem}.{secrets.token_hex(4)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        for number in range(0, 1000):
            final = directory / (f"{stem}.json" if number == 0 else f"{stem}-{number}.json")
            try:
                os.link(tmp, final)
                return final
            except FileExistsError:
                continue
        raise AppError("too many export files with the same name")
    finally:
        os.unlink(tmp)


def pull_from(conn, out_dir: Path | None = None, now: datetime | None = None) -> Path | None:
    """Write the approved, not yet imported submissions to out_dir/approved-<UTC stamp>.json and mark them
    imported, in one transaction: the file is written before the commit and removed again if anything fails
    before the commit is attempted. If the commit itself fails with an unknown outcome the file is kept (it may
    be the only copy of rows the database did mark). Returns the file, or None when nothing was waiting."""
    out_dir = SUBMISSIONS_DIR if out_dir is None else Path(out_dir)
    path = None
    transaction = conn.transaction()
    transaction.__enter__()
    try:
        rows = conn.execute(
            "SELECT id, handle, display_handle, owner_kind, note, decided_at FROM app.submissions "
            "WHERE status = 'approved' AND imported_at IS NULL ORDER BY created_at, id FOR UPDATE").fetchall()
        if rows:
            accounts = _pull_accounts(rows)
            now = datetime.now(timezone.utc) if now is None else now
            out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            path = _write_exclusive(
                out_dir, f"approved-{now.strftime('%Y%m%dT%H%M%SZ')}",
                json.dumps({"pulled_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "accounts": accounts},
                           ensure_ascii=False, indent=2) + "\n")
            ids = [row["id"] for row in rows]
            changed = conn.execute("UPDATE app.submissions SET imported_at = now() WHERE id = ANY(%s) AND imported_at IS NULL",
                                   (ids,)).rowcount
            if changed != len(ids):
                raise AppError("the submissions changed while they were being pulled; nothing was imported")
    except BaseException as error:
        try:
            transaction.__exit__(type(error), error, error.__traceback__)  # roll back
        finally:
            if path is not None:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
        raise
    try:
        transaction.__exit__(None, None, None)  # commit
    except BaseException:
        if path is not None:
            print(f"commit not confirmed; file kept at {path}; run pull again - if it reports nothing waiting, "
                  "this file is the export")
        raise
    if not rows:
        print("no approved submissions waiting")
        return None
    try:
        shown = path.relative_to(ROOT)
    except ValueError:
        shown = path
    print(f"wrote {shown}: {len(accounts)} account(s) from {len(rows)} approved request(s)")
    print("add name and role for each person, then import with pnpm data:panel:import")
    return path


def vote_rows(rows) -> list[dict]:
    """Counts as they are written to the file: one row per topic, quarter and answer, no reader in it."""
    return [{"topic_id": row["topic_id"], "quarter": row["quarter"], "option_id": row["option_id"],
             "votes": int(row["votes"])} for row in rows]


def pull_votes_from(conn, out_dir: Path | None = None, now: datetime | None = None) -> Path:
    """Write readers' votes, counted by topic, quarter and answer, to out_dir/votes-<UTC stamp>.json.

    Only counts leave the database: no reader, no address, no time of a single vote. Nothing is changed
    there, so pulling again later simply writes the counts as they then stand."""
    out_dir = VOTES_DIR if out_dir is None else Path(out_dir)
    rows = conn.execute(
        "SELECT topic_id, quarter, option_id, count(*) AS votes FROM app.topic_votes "
        "GROUP BY topic_id, quarter, option_id ORDER BY topic_id, quarter, option_id").fetchall()
    running = conn.execute("SELECT app.quarter_of(now()) AS quarter").fetchone()["quarter"]
    now = datetime.now(timezone.utc) if now is None else now
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    counts = vote_rows(rows)
    path = _write_exclusive(
        out_dir, f"votes-{now.strftime('%Y%m%dT%H%M%SZ')}",
        json.dumps({"pulled_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "running_quarter": running, "votes": counts},
                   ensure_ascii=False, indent=2) + "\n")
    try:
        shown = path.relative_to(ROOT)
    except ValueError:
        shown = path
    print(f"wrote {shown}: {sum(row['votes'] for row in counts)} vote(s) on "
          f"{len({row['topic_id'] for row in counts})} topic(s); running quarter {running}")
    return path


def pull_votes(target: str) -> None:
    """Pull the vote counts of the server (or the local database) into data/votes/."""
    with _connection_for(target) as conn:
        pull_votes_from(conn)


def _connection_for(target: str):
    """Context manager yielding a connection as oaw_app to the local or the server database."""
    if target == "local":
        return connect_app()
    if target == "server":
        import server_db

        return server_db.server_connection(APP_ROLE)
    raise AppError("--target must be server or local")


def pull(target: str) -> None:
    """Pull the approved submissions of the server (or the local database) into data/submissions/."""
    with _connection_for(target) as conn:
        pull_from(conn)


def sync_admins_to(target: str) -> None:
    """Make the administrator list in the database equal to ADMIN_EMAILS in the local .env. Counts only."""
    emails = read_admin_emails()
    if not emails:
        raise AppError("ADMIN_EMAILS is empty in the local .env; the administrator list was left unchanged")
    with _connection_for(target) as conn:
        added, removed = sync_admins(conn, emails)
    print(f"administrators on the {target}: {len(emails)} on the list (+{added}, -{removed})")
