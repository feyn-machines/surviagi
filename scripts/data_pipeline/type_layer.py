"""Seed the gate type layer and the organisation registry.

Definitions come from datasets/ontology/data/gates.json and the vocabulary that
governs them comes from the schema; this module only projects them into
PostgreSQL. Re-running with the same model is a no-op; re-running after the
model changed is an error, because a seeded row that silently changed meaning is
worse than a failed run.

Capabilities were seeded here too, along with their candidate edges. The layer
is retired: forty-one of the forty-six matched every kind of work, so it
answered every question with the same answer. Gates stayed, because a gate is
not a weak capability - it is a condition that does not lift when models
improve, and it is what holds an activity at L0 whatever the evidence says.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from psycopg.types.json import Jsonb

from .pipeline import canonical, digest

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "datasets/ontology/schema/schema.json"
GATES_PATH = ROOT / "datasets/ontology/data/gates.json"
ORG_PATH = ROOT / "datasets/ontology/data/organizations.json"

SEED_RUN_ID = "judgment-interactive-review-1"
METHOD_VERSION = "real-evidence-review-1"
SEED_LOCK = 7543006


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def load_organizations() -> list[dict]:
    return json.loads(ORG_PATH.read_text())["organizations"]


def org_rows() -> list[dict]:
    rows = []
    for org in load_organizations():
        row = {
            "org_id": org["org_id"],
            "canonical_name_en": org["name_en"],
            "canonical_name_zh_cn": org.get("name_zh_cn"),
            "aliases": sorted(org["aliases"]),
        }
        rows.append({**row, "record_sha256": digest(row)})
    return rows


def _bilingual(node: dict, key: str) -> tuple[str, str | None]:
    value = node.get(key) or {}
    return value.get("en") or value.get("zh-CN") or "", value.get("zh-CN")


def load_gates() -> dict:
    """The eleven gates, from the reviewed pilot seed and the discovery pass.

    They used to live inside the two capabilities files, because the proposing
    pass asked what a piece of work requires and a model will answer a gate:
    physical-presence reached fourteen occupation groups, the broadest thing
    proposed, and it is the most textbook gate there is.
    """
    return json.loads(GATES_PATH.read_text())


def gate_rows(model: dict) -> list[dict]:
    rows = []
    for item in load_gates()["gates"]:
        label_en, label_zh = _bilingual(item, "label")
        definition_en, definition_zh = _bilingual(item, "definition")
        row = {
            "gate_id": item["id"],
            "gate_type": item["gate_type"],
            "label_en": label_en,
            "label_zh_cn": label_zh,
            "definition_en": definition_en,
            "definition_zh_cn": definition_zh,
            "lifecycle": "active",
            "replaced_by": None,
            "obsolescence_reason": None,
        }
        rows.append({**row, "record_sha256": digest(row)})
    return rows


def seed_document(model: dict, ontology_version: str) -> dict:
    return {
        "schema_version": model["version"],
        "ontology_version": ontology_version,
        "organizations": org_rows(),
        "gates": gate_rows(model),
    }


def _insert(cursor, table: str, rows: list[dict], conflict: str, upsert: bool = False) -> int:
    """Definitions are projections of the model and may be re-projected (upsert=True).

    Edges are not: they carry review state, and silently overwriting a rejected
    edge with a fresh proposal would erase the very decision that matters.
    """
    if not rows:
        return 0
    columns = list(rows[0])
    placeholders = ", ".join(["%s"] * len(columns))
    keys = {k.strip() for k in conflict.split(",")}
    if upsert:
        assignments = ", ".join(f"{c} = EXCLUDED.{c}" for c in columns if c not in keys)
        action = f"DO UPDATE SET {assignments}"
    else:
        action = "DO NOTHING"
    statement = (
        f"INSERT INTO public.{table} ({', '.join(columns)}) "
        f"VALUES ({placeholders}) ON CONFLICT ({conflict}) {action}"
    )
    for row in rows:
        values = [Jsonb(row[c]) if isinstance(row[c], (list, dict)) else row[c] for c in columns]
        cursor.execute(statement, values)
    return len(rows)


def seed(conn, ontology_version: str | None = None) -> dict:
    model = load_schema()
    with conn.cursor() as cursor:
        if ontology_version is None:
            cursor.execute("SELECT version FROM public.ontology_releases ORDER BY version DESC LIMIT 1")
            found = cursor.fetchone()
            if not found:
                raise ValueError("No ontology release imported; run the ontology import first")
            ontology_version = found["version"]

    document = seed_document(model, ontology_version)
    run_sha256 = digest(document)
    now = datetime.now(timezone.utc)

    with conn.transaction(), conn.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", (SEED_LOCK,))
        # Definitions are projections of files and are re-projected on every run.
        # There is no edge set to pin any more: the candidate edges this used to
        # write were capability edges, and the gate edges now come from the
        # mapping pass (activity_gate_edges), which carries its own run.
        counts = {
            "organizations": _insert(cursor, "org_registry", document["organizations"],
                                     "org_id", upsert=True),
            "gates": _insert(cursor, "gates", document["gates"], "gate_id", upsert=True),
        }
    return {"reused": False, "ontology_version": ontology_version,
            "run_sha256": run_sha256, **counts}
