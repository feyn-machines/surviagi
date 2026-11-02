"""Fixed local PostgreSQL connection and transactional, hash-checked migrations."""

import hashlib
import os
from pathlib import Path
import re
import stat

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "db/migrations"
PASSWORD = ROOT / "data/postgres/password"
# A branch with a new migration is verified against a scratch database
# (OAW_DATA_DATABASE): migrate() on the working one would apply a file main does
# not have, and the next daily run stops on "changed or is missing".
DATABASE = os.environ.get("OAW_DATA_DATABASE", "openaiwill_local")


def connect(database=None):
    """Connect to the dedicated loopback instance; tests may select another DB."""
    if PASSWORD.is_symlink() or not PASSWORD.is_file():
        raise RuntimeError("Run python3 scripts/data-local.py setup first")
    if stat.S_IMODE(PASSWORD.stat().st_mode) != 0o600:
        raise RuntimeError("Local PostgreSQL password file must have mode 0600")
    return psycopg.connect(
        host="127.0.0.1", port=7543, dbname=DATABASE if database is None else database,
        user="openaiwill", password=PASSWORD.read_text().strip(),
        autocommit=True, row_factory=dict_row, connect_timeout=5,
        application_name="openaiwill-local-data", options="-c timezone=UTC -c search_path=public",
    )


def migrate(conn):
    """Apply new migrations atomically; reject changed or missing applied files."""
    files = sorted(MIGRATIONS.glob("*.sql"))
    versions = [path.name.split("_", 1)[0] for path in files]
    if not files or len(set(versions)) != len(versions) or any(
        not re.fullmatch(r"[0-9]{3}_[a-z0-9_]+\.sql", path.name) for path in files
    ):
        raise ValueError("Migrations need unique three-digit versions and valid SQL filenames")
    contents = {path.name: path.read_bytes() for path in files}
    hashes = {name: hashlib.sha256(value).hexdigest() for name, value in contents.items()}
    applied = []
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(790691154103001)")
        conn.execute("""CREATE TABLE IF NOT EXISTS public.schema_migrations (
            version text PRIMARY KEY,
            sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
            applied_at timestamptz NOT NULL DEFAULT now())""")
        existing = {row["version"]: row["sha256"] for row in conn.execute(
            "SELECT version, sha256 FROM public.schema_migrations ORDER BY version"
        )}
        for name, digest in existing.items():
            if name not in hashes or hashes[name] != digest:
                raise ValueError(f"Applied migration has changed or is missing: {name}")
        for path in files:
            if path.name in existing:
                continue
            if existing and path.name < max(existing):
                raise ValueError(f"Cannot insert an earlier migration: {path.name}")
            conn.execute(contents[path.name].decode("utf-8"))
            conn.execute("INSERT INTO public.schema_migrations (version, sha256) VALUES (%s, %s)",
                         (path.name, hashes[path.name]))
            applied.append(path.name)
    return applied
