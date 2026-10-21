"""Published data as versioned, immutable releases in the `kg` schema.

The published snapshot (nine JSON files) is stored row by row. A row's body is
content-addressed in kg.docs, so a release that changes 30 of 20,000 rows writes
30 documents; kg.release_rows says which documents make up which release.
Importing never touches anything outside `kg`, so later user data in the same
database is never disturbed by a data update.

The one guarantee that matters: a release becomes `verified` only after the
payload has been reassembled *from the database* and hashed with the pipeline's
own `digest`, and the result equals the manifest's `content_sha256`.

This module does not import psycopg at module level: its pure parts (pack,
unpack, release_id, diff_rows) are unit-tested with the system python.
"""
from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from .pipeline import ROOT, canonical, digest

SCHEMA_FILE = ROOT / "db/published/001_kg.sql"
SNAPSHOT_DIR = ROOT / "datasets/published/latest"
SNAPSHOT_FILES = ("chain", "markets", "tasks", "events", "models", "sources", "topics", "coverage", "progress")

# Collection -> the document field that is its entity id (None: no natural id).
# A field is listed only if it is present and unique in the published data, and
# test_data_kg_unit asserts that against the real snapshot. `markets` is None on
# purpose: market_id repeats once per occupation (257 distinct in 1,888 rows).
# Order is fixed: it is the order rows are written and diffs are printed.
COLLECTIONS: dict[str, str | None] = {
    "chain.activities": "activity_id",
    "chain.gates": "gate_id",
    "chain.events": "event_id",
    "chain.evidence": None,
    "chain.gate_edges": None,
    "markets": None,
    "tasks": None,
    "events": "event_id",
    "models": "model_id",
    "sources": "account_key",
    "topics": "topic_id",
    "coverage": None,
    "progress": None,
}
# Documents that are one object, not a list of rows.
SINGLE_DOCUMENTS = frozenset({"coverage", "progress"})

BATCH = 5000
LOCK_KEY = 790691154103002


class KgError(Exception):
    """A release problem the operator can act on; the CLI prints it as one line."""


@dataclass(frozen=True)
class Row:
    collection: str
    ord: int
    entity_id: str | None
    sha256: str
    doc: Any


@dataclass(frozen=True)
class ImportResult:
    release_id: str
    seq: int
    created: bool
    docs_written: int


def _counts(payload: dict) -> dict[str, int]:
    """The manifest's `counts` shape, derived from a payload."""
    return {
        **{f"chain.{key}": len(value) for key, value in payload["chain"].items()},
        **{key: len(value) for key, value in payload.items() if isinstance(value, list)},
        **{key: 1 for key, value in payload.items() if isinstance(value, dict) and key != "chain"},
    }


def read_snapshot(directory: Path = SNAPSHOT_DIR) -> tuple[dict, dict]:
    """(payload, manifest) of a snapshot directory, refusing one that does not describe itself."""
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        raise KgError(f"no manifest at {manifest_path}; run `pnpm data:publish:snapshot`")
    try:
        manifest = json.loads(manifest_path.read_text())
    except ValueError as error:
        raise KgError(f"manifest.json is not valid JSON: {error}") from error
    payload = {}
    for name in SNAPSHOT_FILES:
        path = directory / f"{name}.json"
        if not path.is_file():
            raise KgError(f"snapshot file missing: {name}.json")
        try:
            payload[name] = json.loads(path.read_text())
        except ValueError as error:
            raise KgError(f"{name}.json is not valid JSON: {error}") from error
    verify_payload(payload, manifest)
    return payload, manifest


def check_shape(payload: Any) -> None:
    """Every collection present with the right container type, or a one-line KgError.

    A malformed snapshot must be reported, not crash `_counts` or `pack` with a
    traceback halfway through.
    """
    expected = {name.split(".")[0] for name in COLLECTIONS}
    if not isinstance(payload, dict) or set(payload) != expected or not isinstance(payload.get("chain"), dict):
        raise KgError(f"payload collections differ from {sorted(expected)}")
    if set(payload["chain"]) != {n.split(".")[1] for n in COLLECTIONS if n.startswith("chain.")}:
        raise KgError(f"chain collections differ from the known ones: {sorted(payload['chain'])}")
    for name in COLLECTIONS:
        value = _collection(payload, name)
        want = dict if name in SINGLE_DOCUMENTS else list
        if not isinstance(value, want):
            raise KgError(f"{name} must be a JSON {'object' if want is dict else 'array'}")


def verify_payload(payload: dict, manifest: dict) -> None:
    """The payload must be exactly what the manifest says it is."""
    check_shape(payload)
    if _counts(payload) != manifest.get("counts"):
        raise KgError("snapshot counts do not match its manifest")
    if digest(payload) != manifest.get("content_sha256"):
        raise KgError("snapshot content_sha256 does not match its files")


def release_id(manifest: dict) -> str:
    """`<generated_at UTC YYYYMMDDTHHMMSSZ>-<content_sha256[:8]>`: sortable, and unique per content."""
    try:
        generated = datetime.fromisoformat(str(manifest["generated_at"]).replace("Z", "+00:00"))
        content = manifest["content_sha256"]
    except (KeyError, ValueError) as error:
        raise KgError(f"manifest has no usable generated_at / content_sha256: {error}") from error
    if generated.tzinfo is None:
        raise KgError("manifest generated_at needs a timezone")
    return f"{generated.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}-{content[:8]}"


def _collection(payload: dict, name: str) -> Any:
    node = payload
    for part in name.split("."):
        node = node[part]
    return node


def pack(payload: dict) -> list[Row]:
    """One Row per list element; a single-object collection is one row at ord 0.

    A payload with a collection this module does not know is refused rather than
    dropped, and an entity id that repeats in its collection is refused: ids are
    how releases are compared and how user data will point at an entity.
    """
    check_shape(payload)
    rows = []
    for name, id_field in COLLECTIONS.items():
        value = _collection(payload, name)
        docs = [value] if name in SINGLE_DOCUMENTS else value
        seen = set()
        for ord_, doc in enumerate(docs):
            entity_id = None
            if id_field is not None:
                entity_id = doc.get(id_field) if isinstance(doc, dict) else None
                if not isinstance(entity_id, str) or not entity_id:
                    raise KgError(f"{name}[{ord_}] has no string {id_field}")
                if entity_id in seen:
                    raise KgError(f"{name} has the entity id {entity_id!r} more than once")
                seen.add(entity_id)
            rows.append(Row(name, ord_, entity_id, digest(doc), doc))
    return rows


def unpack(rows: Iterable[tuple[str, int, Any]]) -> dict:
    """Inverse of pack from (collection, ord, doc); row order does not matter."""
    grouped: dict[str, list[tuple[int, Any]]] = {name: [] for name in COLLECTIONS}
    for collection, ord_, doc in rows:
        if collection not in grouped:
            raise KgError(f"unknown collection in release: {collection}")
        grouped[collection].append((ord_, doc))
    payload: dict = {"chain": {}}
    for name in COLLECTIONS:
        docs = [doc for _, doc in sorted(grouped[name], key=lambda item: item[0])]
        if name in SINGLE_DOCUMENTS:
            if len(docs) != 1:
                raise KgError(f"{name} must be exactly one document, found {len(docs)}")
            value = docs[0]
        else:
            value = docs
        if name.startswith("chain."):
            payload["chain"][name.split(".")[1]] = value
        else:
            payload[name] = value
    return payload


def diff_rows(new: Iterable[tuple[str, str | None, str]], old: Iterable[tuple[str, str | None, str]]) -> dict[str, dict]:
    """Per collection: rows added / changed / removed, and whether the order changed.

    Triples are (collection, entity_id, sha256) in row order. With an entity id, a
    row is matched to its predecessor by id, so an edited row is `changed`.
    Without one there is nothing to match on: rows compare as a multiset of
    content, and an edit is one removal plus one addition. `reordered` is true when
    the rows both sides share sit in a different order; the content hash covers
    order, so a release that only reorders rows must not read as "no change".
    """
    result = {name: {"added": 0, "changed": 0, "removed": 0, "reordered": False} for name in COLLECTIONS}
    new, old = list(new), list(old)
    for name, id_field in COLLECTIONS.items():
        a = [(e, s) for c, e, s in new if c == name]
        b = [(e, s) for c, e, s in old if c == name]
        out = result[name]
        if id_field is None:
            fresh, gone = Counter(s for _, s in a), Counter(s for _, s in b)
            out["added"] = sum((fresh - gone).values())
            out["removed"] = sum((gone - fresh).values())
            if not out["added"] and not out["removed"]:
                out["reordered"] = [s for _, s in a] != [s for _, s in b]
        else:
            mine, theirs = dict(a), dict(b)
            shared = mine.keys() & theirs.keys()
            out["added"] = len(mine.keys() - theirs.keys())
            out["removed"] = len(theirs.keys() - mine.keys())
            out["changed"] = sum(1 for k in shared if mine[k] != theirs[k])
            out["reordered"] = [e for e, _ in a if e in shared] != [e for e, _ in b if e in shared]
    return result


# ---------------------------------------------------------------- database ----

def _tuples(conn):
    """A cursor whose rows are tuples whatever row factory the connection was made with."""
    from psycopg.rows import tuple_row
    return conn.cursor(row_factory=tuple_row)


def ensure_schema(conn) -> None:
    """Create the kg schema if absent. Safe to repeat; never alters existing data."""
    with conn.transaction(), _tuples(conn) as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        cur.execute("SELECT data_type FROM information_schema.columns "
                    "WHERE table_schema = 'kg' AND table_name = 'docs' AND column_name = 'doc'")
        found = cur.fetchone()
        if found and found[0] != "json":
            raise KgError("the local kg schema predates the json column; run: data-release.py reset --target local")
        cur.execute(SCHEMA_FILE.read_text())


def reset(conn) -> None:
    """Drop the kg schema and recreate it empty. Destroys every release: local use only."""
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        conn.execute("DROP SCHEMA IF EXISTS kg CASCADE")
    ensure_schema(conn)


def _find(cur, **where) -> tuple | None:
    (column, value), = where.items()
    cur.execute(f"SELECT seq, release_id, status FROM kg.releases WHERE {column} = %s", (value,))
    return cur.fetchone()


def import_release(conn, payload: dict, manifest: dict) -> ImportResult:
    """Store a snapshot as a verified release, atomically and idempotently.

    Re-importing a verified release changes nothing. A `loading` leftover with the
    same hash (an importer that died after committing) is removed and redone.
    Verification rebuilds the payload from the database; on any mismatch the whole
    transaction rolls back, so a bad import leaves no release behind.
    """
    verify_payload(payload, manifest)
    rows = pack(payload)
    rid = release_id(manifest)
    content = manifest["content_sha256"]
    with conn.transaction(), _tuples(conn) as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        found = _find(cur, content_sha256=content)
        if found and found[2] == "verified":
            return ImportResult(found[1], found[0], False, 0)
        if found:
            _remove_loading(cur, found[0])
        cur.execute(
            "INSERT INTO kg.releases (release_id, content_sha256, generated_at, manifest, status) "
            "VALUES (%s, %s, %s, %s::jsonb, 'loading') RETURNING seq",
            (rid, content, manifest["generated_at"], canonical(manifest)))
        seq = cur.fetchone()[0]
        written = _write_documents(cur, rows)
        _write_membership(cur, seq, rows)
        cur.execute(
            "INSERT INTO kg.entities (collection, entity_id, first_release_seq) "
            "SELECT DISTINCT collection, entity_id, release_seq FROM kg.release_rows "
            "WHERE release_seq = %s AND entity_id IS NOT NULL ON CONFLICT DO NOTHING", (seq,))
        if digest(load_release(conn, seq)) != content:
            raise KgError(f"release {rid} does not reassemble to its content_sha256; nothing was stored")
        cur.execute("UPDATE kg.releases SET status = 'verified', verified_at = now() WHERE seq = %s", (seq,))
    return ImportResult(rid, seq, True, written)


def _remove_loading(cur, seq: int) -> None:
    """Drop an unverified release and the identities only it had registered."""
    cur.execute("DELETE FROM kg.entities WHERE first_release_seq = %s", (seq,))
    cur.execute("DELETE FROM kg.releases WHERE seq = %s AND status = 'loading'", (seq,))


def _write_documents(cur, rows: list[Row]) -> int:
    """Insert bodies not stored yet and return how many were new.

    COPY into a temporary table first: it is the fast path for ~20,000 rows, and
    `INSERT … SELECT … ON CONFLICT DO NOTHING` gives an exact new-row count. The
    column is `json`, not `jsonb`: json keeps the text as sent, so a number such
    as 1e+22 or -0.0 reads back byte-for-byte and the hash holds by construction.
    """
    # The snapshot contains every row, while only changed document bodies need to cross the SSH forward.
    # Advisory locking in import_release makes this lookup and the insert one consistent operation.
    hashes = [row.sha256 for row in rows]
    cur.execute("SELECT sha256 FROM kg.docs WHERE sha256 = ANY(%s)", (hashes,))
    known = {sha256 for (sha256,) in cur.fetchall()}
    pending = [row for row in rows if row.sha256 not in known]
    if not pending:
        return 0
    cur.execute("CREATE TEMP TABLE kg_incoming (sha256 text, doc text) ON COMMIT DROP")
    with cur.copy("COPY kg_incoming (sha256, doc) FROM STDIN") as copy:
        for row in pending:
            copy.write_row((row.sha256, canonical(row.doc)))
    cur.execute("INSERT INTO kg.docs (sha256, doc) SELECT DISTINCT ON (sha256) sha256, doc::json "
                "FROM kg_incoming ON CONFLICT (sha256) DO NOTHING")
    return cur.rowcount


def _write_membership(cur, seq: int, rows: list[Row]) -> None:
    with cur.copy("COPY kg.release_rows (release_seq, collection, ord, entity_id, sha256) FROM STDIN") as copy:
        for row in rows:
            copy.write_row((seq, row.collection, row.ord, row.entity_id, row.sha256))


def load_release(conn, seq: int) -> dict:
    """The payload of a release, reassembled from the database."""
    with _tuples(conn) as cur:
        cur.execute("SELECT m.collection, m.ord, d.doc FROM kg.release_rows m JOIN kg.docs d USING (sha256) "
                    "WHERE m.release_seq = %s", (seq,))
        return unpack(cur.fetchall())


def _membership(cur, seq: int) -> list[tuple]:
    cur.execute("SELECT collection, entity_id, sha256 FROM kg.release_rows WHERE release_seq = %s ORDER BY collection, ord", (seq,))
    return cur.fetchall()


def diff(conn, seq: int, against_seq: int | None) -> dict[str, dict]:
    """Rows added / changed / removed per collection going from `against_seq` to `seq`."""
    with _tuples(conn) as cur:
        old = _membership(cur, against_seq) if against_seq is not None else []
        return diff_rows(_membership(cur, seq), old)


def _active_seq(cur) -> int | None:
    cur.execute("SELECT release_seq FROM kg.activations ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    return row[0] if row else None


def active_seq(conn) -> int | None:
    with _tuples(conn) as cur:
        return _active_seq(cur)


def _activate(cur, release_id: str, note: str) -> None:
    """Activation under the caller's transaction and lock."""
    found = _find(cur, release_id=release_id)
    if not found:
        raise KgError(f"unknown release: {release_id}")
    if found[2] != "verified":
        raise KgError(f"release {release_id} is {found[2]}, only a verified release can be activated")
    if _active_seq(cur) == found[0]:
        return
    cur.execute("INSERT INTO kg.activations (release_seq, note) VALUES (%s, %s)", (found[0], note or None))


def activate(conn, release_id: str, note: str = "") -> None:
    """Make a verified release the live one. A no-op if it already is."""
    with conn.transaction(), _tuples(conn) as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        _activate(cur, release_id, note)


def rollback(conn) -> str:
    """Re-activate the release that was live before the current one; return its id.

    The history is read under the same lock as the write, so two concurrent
    rollbacks cannot both act on the same "current" release.
    """
    with conn.transaction(), _tuples(conn) as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        cur.execute("SELECT r.release_id, a.release_seq FROM kg.activations a JOIN kg.releases r ON r.seq = a.release_seq "
                    "ORDER BY a.id DESC")
        history = cur.fetchall()
        if not history:
            raise KgError("nothing is active, nothing to roll back")
        previous = next((rid for rid, seq in history if seq != history[0][1]), None)
        if previous is None:
            raise KgError("no earlier release was ever active")
        _activate(cur, previous, "rollback")
    return previous


def status(conn) -> dict:
    """Releases newest first, and the id of the active one (None before any activation)."""
    with _tuples(conn) as cur:
        cur.execute("SELECT seq, release_id, status, content_sha256, generated_at, imported_at, manifest->'counts' "
                    "FROM kg.releases ORDER BY seq DESC")
        releases = [{"seq": s, "release_id": r, "status": st, "content_sha256": h,
                     "generated_at": g.isoformat(), "imported_at": i.isoformat(), "counts": c}
                    for s, r, st, h, g, i, c in cur.fetchall()]
        active = _active_seq(cur)
    active_id = next((r["release_id"] for r in releases if r["seq"] == active), None)
    return {"releases": releases, "active": active_id}
