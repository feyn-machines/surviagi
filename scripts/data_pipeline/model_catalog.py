"""A reference list of our companies' recent models, taken from models.dev.

The model registry grows from mentions (model_identification): a name with no
alias opens a candidate. This step puts the names a catalog already knows into
the alias table first, so a mention resolves to an existing model before a new
candidate is opened.

models.dev lists one record per provider that serves a model; the model's
identity and owner are in `canonical_model_id` ("anthropic/claude-opus-5-5").
Selection is by that owner, never by the listing provider.

A catalog entry says the model exists under that name. It does not confirm it:
status still moves to `confirmed` only on the owner's own release update.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import date, datetime, timezone
from urllib.request import Request, urlopen

from . import ontology_schema
from .model_identification import _slug, normalize
from .pipeline import ROOT

MODALITIES = ontology_schema.term_ids("modality")
MAPPING = ROOT / "datasets/ontology/data/model-catalog-map.json"
SNAPSHOTS = ROOT / "data/reference/models-dev"


def load_mapping(path=MAPPING):
    return json.loads(path.read_text())


def fetch(mapping, now=None):
    """Download today's snapshot under ignored data/; returns its path."""
    now = now or datetime.now(timezone.utc)
    request = Request(mapping["url"], headers={"User-Agent": "openaiwill-local-data"})
    with urlopen(request, timeout=60) as response:
        body = response.read()
    json.loads(body)  # a snapshot that is not JSON is not kept
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    path = SNAPSHOTS / f"models-dev-{now:%Y%m%dT%H%M%SZ}.json"
    path.write_bytes(body)
    return path


def select(doc, mapping):
    """Snapshot -> one row per canonical model owned by a mapped company and released since the cutoff."""
    since = date.fromisoformat(mapping["since"])
    providers = {p["key"]: p for p in mapping["providers"]}
    found = {}
    for provider_key, provider in doc.items():
        for record in (provider.get("models") or {}).values():
            canonical = record.get("canonical_model_id")
            if not canonical or "/" not in canonical or not record.get("name"):
                continue
            owner = canonical.split("/", 1)[0]
            if owner not in mapping["owners"] or "latest" in f"{canonical} {record['name']}".lower():
                continue
            try:
                listed = date.fromisoformat(record["release_date"])
            except (KeyError, TypeError, ValueError):
                continue
            entry = found.setdefault(canonical, {"names": Counter(), "own": [], "dates": [], "listings": {},
                                                 "facts": [], "own_facts": []})
            entry["names"][record["name"]] += 1
            entry["dates"].append(listed)
            outputs = (record.get("modalities") or {}).get("output")
            facts = (record.get("open_weights") if isinstance(record.get("open_weights"), bool) else None,
                     tuple(sorted(set(outputs))) if isinstance(outputs, list) else None)
            entry["facts"].append(facts)
            listing = providers.get(provider_key)
            if listing:
                entry["listings"][provider_key] = min(listed, entry["listings"].get(provider_key, listed))
                if listing["kind"] == "first_party" and listing["org_id"] == mapping["owners"][owner]:
                    entry["own"].append(record["name"])
                    entry["own_facts"].append(facts)
    rows = []
    for canonical, entry in found.items():
        released = min(entry["dates"])
        if released < since:
            continue
        slug = canonical.split("/", 1)[1]
        by_use = sorted(entry["names"], key=lambda n: (-entry["names"][n], n))
        # A maker's API often serves its newest model under a moving id ("DeepSeek V4 Flash"
        # for deepseek-v4.1-flash), so a listed name that spells the canonical id comes first.
        exact = [n for n in by_use if normalize(n) == normalize(slug)]
        name = exact[0] if exact else sorted(entry["own"])[0] if entry["own"] else by_use[0]
        aliases = []
        for spelling in (slug, name):
            key = normalize(spelling)
            if key and key not in aliases:
                aliases.append(key)
        open_weights, outputs = (_agreed(entry["own_facts"] or entry["facts"], field) for field in (0, 1))
        rows.append({"catalog_id": canonical, "org_id": mapping["owners"][canonical.split("/", 1)[0]],
                     "name": name, "released_on": released, "aliases": aliases,
                     "open_weights": open_weights,
                     "output_modalities": [m for m in outputs or () if m in MODALITIES],
                     "offerings": sorted(entry["listings"].items())})
    return sorted(rows, key=lambda r: (r["released_on"], r["catalog_id"]))


def _agreed(facts, field):
    """The one value every listing gives; None when they disagree or none says (rule:catalog-disagreement-is-null)."""
    values = {fact[field] for fact in facts}
    return values.pop() if len(values) == 1 else None


def family_of(name, org_id, models, aliases):
    """The family a catalog name belongs to: its longest leading words that name a family of the same owner."""
    words = normalize(name).split()
    for length in range(len(words) - 1, 0, -1):
        hit = aliases.get(" ".join(words[:length]))
        if hit and models[hit]["level"] == "family" and models[hit]["org_id"] == org_id:
            return hit
    return None


def apply(conn, rows, mapping, snapshot_sha256, fetched_at):
    """Write the selected rows into the registry. Idempotent; never rewrites what a mention established."""
    for provider in mapping["providers"]:
        conn.execute(
            """INSERT INTO public.model_providers (provider_id, name, kind, org_id)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (provider_id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
                 org_id = excluded.org_id""",
            (f"provider:{provider['key']}", provider["name"], provider["kind"], provider["org_id"]))
    models = {m["model_id"]: m for m in conn.execute("SELECT * FROM public.models").fetchall()}
    aliases = {r["alias"]: r["model_id"] for r in
               conn.execute("SELECT alias, model_id FROM public.model_aliases").fetchall()}
    by_catalog = {m["catalog_id"]: key for key, m in models.items() if m["catalog_id"]}
    counts = dict.fromkeys(("matched", "added", "aliases_added", "offerings", "skipped_name_taken",
                            "skipped_already_matched"), 0) | {"selected": len(rows)}
    for row in rows:
        new_id = f"model:{row['org_id'].split(':', 1)[1]}:{_slug(row['name'])}"
        model_id = by_catalog.get(row["catalog_id"])
        if model_id is None:
            hits = [aliases[a] for a in row["aliases"] if a in aliases] + ([new_id] if new_id in models else [])
            model_id = next((h for h in hits if models[h]["level"] == "release"
                             and models[h]["org_id"] == row["org_id"]), None)
            if model_id is None and hits:
                counts["skipped_name_taken"] += 1  # the name already means a family or another owner's model
                continue
            if model_id is not None and models[model_id]["catalog_id"]:
                counts["skipped_already_matched"] += 1  # two catalog entries, one registry model
                continue
        if model_id is None:
            model_id = new_id
            conn.execute(
                """INSERT INTO public.models (model_id, org_id, level, parent_model_id, name, status,
                                             catalog_id, catalog_released_on)
                   VALUES (%s, %s, 'release', %s, %s, 'candidate', %s, %s)""",
                (model_id, row["org_id"], family_of(row["name"], row["org_id"], models, aliases),
                 row["name"], row["catalog_id"], row["released_on"]))
            models[model_id] = {"model_id": model_id, "level": "release", "org_id": row["org_id"],
                                "catalog_id": None}
            counts["added"] += 1
        else:
            if models[model_id]["catalog_id"] is None:
                counts["matched"] += 1
            conn.execute("UPDATE public.models SET catalog_id = %s, catalog_released_on = %s WHERE model_id = %s",
                         (row["catalog_id"], row["released_on"], model_id))
        conn.execute("UPDATE public.models SET open_weights = %s WHERE model_id = %s",
                     (row["open_weights"], model_id))
        conn.execute("DELETE FROM public.model_output_modalities WHERE model_id = %s", (model_id,))
        for modality in row["output_modalities"]:
            conn.execute("INSERT INTO public.model_output_modalities (model_id, modality) VALUES (%s, %s)",
                         (model_id, modality))
        models[model_id]["catalog_id"] = row["catalog_id"]
        by_catalog[row["catalog_id"]] = model_id
        for alias in row["aliases"]:
            if alias not in aliases:
                aliases[alias] = model_id
                conn.execute("INSERT INTO public.model_aliases (alias, model_id) VALUES (%s, %s) "
                             "ON CONFLICT (alias) DO NOTHING", (alias, model_id))
                counts["aliases_added"] += 1
        for provider_key, listed_on in row["offerings"]:
            conn.execute(
                """INSERT INTO public.model_offerings (model_id, provider_id, listed_on)
                   VALUES (%s, %s, %s)
                   ON CONFLICT (model_id, provider_id) DO UPDATE SET listed_on = excluded.listed_on""",
                (model_id, f"provider:{provider_key}", listed_on))
            counts["offerings"] += 1
    import_id = f"catalog-{fetched_at:%Y%m%dT%H%M%SZ}-{snapshot_sha256[:8]}"
    conn.execute(
        """INSERT INTO public.model_catalog_imports (import_id, source, url, fetched_at, snapshot_sha256, since, counts)
           VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
           ON CONFLICT (import_id) DO UPDATE SET counts = excluded.counts""",
        (import_id, mapping["source"], mapping["url"], fetched_at, snapshot_sha256, mapping["since"],
         json.dumps(counts)))
    return {"import_id": import_id, **counts}


def run(conn, snapshot=None):
    """Import a snapshot file, downloading one when none is given."""
    mapping = load_mapping()
    path = snapshot or fetch(mapping)
    body = path.read_bytes()
    fetched_at = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    with conn.transaction():
        result = apply(conn, select(json.loads(body), mapping), mapping,
                       hashlib.sha256(body).hexdigest(), fetched_at)
    return {"snapshot": str(path), **result}
