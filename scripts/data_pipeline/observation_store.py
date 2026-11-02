"""Observations into PostgreSQL (Issue #25, ontology 2.5.0).

One run of the observation call is an immutable document under
data/observations/runs/ (it quotes third-party posts, so it stays local), and
`ingest_observations` writes it in one transaction: the run, the posts it read,
each observation with its sources and facts, and what the run said about each.

  build_run           (pure: candidates + model output -> the run document)
  build_rows          (pure: run document -> rows)
  ingest_observations (writes; the same document again changes nothing)

An observation id is fixed when it is first written: an observation found
again by a later run adds its new sources and facts and keeps everything else
(rule:observation-is-one-actor-one-subject-one-work). Until the mapping pass,
work_key is 'unmapped' and the identity takes the work as the model wrote it.
When mapping later makes two observations the same, they are merged then, and
the id that goes away is kept as a redirect (observation_mapping); what a later
run finds again under that id is written under both.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import ontology_schema
from .observation_extraction import EXTRACTOR, assemble_observations
from .pipeline import digest


def read_source_ids(conn, extractor=EXTRACTOR):
    """Posts this extractor version has already read."""
    rows = conn.execute("SELECT source_id FROM observation_reads WHERE extractor = %s", (extractor,)).fetchall()
    return {row["source_id"] for row in rows}


def build_run(candidates, batches, failures, batch_size, meta):
    """The run document: what was read, what was found, what was refused.

    The posts of a failed batch are not counted as read, so a later run reads them.
    """
    failed = {failure["batch"] for failure in failures}
    read = [c["source_id"] for number in range(1, len(batches) + 1) if number not in failed
            for c in candidates[(number - 1) * batch_size:number * batch_size]]
    observations, refused = assemble_observations(candidates, batches)
    return {**meta, "extractor": EXTRACTOR, "schema_version": ontology_schema.SCHEMA_VERSION,
            "params": {**meta.get("params", {}), "batch_size": batch_size, "failed_batches": failures},
            "candidate_count": len(candidates), "read": read,
            "observations": observations, "refused": refused}


def _short_hash(*parts):
    return hashlib.sha256("\n".join(str(p or "") for p in parts).encode()).hexdigest()[:16]


def build_rows(doc, run_id):
    """Rows of one run document, and how many sources had no quote of their own.

    A source row needs words checked against that source
    (rule:observation-quotes-are-found-in-the-source): the observation's quote
    where it was found, else a fact quoted from that post; a post with neither is
    left out. An observation left without any source is not written.
    """
    observations, sources, facts, readings, unquoted = [], [], [], [], 0
    for item in doc["observations"]:
        oid = item["draft_id"]
        own = []
        for source in item["sources"]:
            quote = source.get("quote") or next(
                (f["quote"] for f in item["facts"] if f["source_id"] == source["source_id"]), None)
            if not quote or not source.get("url"):
                unquoted += 1
                continue
            own.append({"source_ref": "obs-src-" + _short_hash(oid, source["url"]), "observation_id": oid,
                        "url": source["url"], "source_id": source["source_id"], "quote": quote,
                        "published_at": source.get("published_at")})
        if not own:
            continue
        sources += own
        announced = min((s["published_at"] for s in own if s["published_at"]), default=None)
        observations.append({
            "observation_id": oid, "actor_key": item["actor_key"], "actor_name": item["actor"],
            "actor_role": item["actor_role"], "subject_key": item["subject_key"], "work_key": item["work_key"],
            "task": item["task"], "evidence_type": item["evidence_type"], "outcome": item["outcome"],
            "direction": item["direction"], "scale": item["scale"], "conditions": item["conditions"],
            "occurred_on": item["occurred_on"] if item.get("occurred_stated") else None,
            "announced_at": announced, "source_ids": [s["source_id"] for s in own],
            "extractor": doc["extractor"], "prompt_sha256": doc["prompt_sha256"], "model": doc["model"],
            "schema_version": doc["schema_version"]})
        for fact in item["facts"]:
            facts.append({"fact_id": "fact-" + _short_hash(oid, fact["value"], fact["unit"], fact["what"],
                                                         fact["quote"]),
                          "observation_id": oid, "value": fact["value"], "unit": fact["unit"],
                          "what": fact["what"], "baseline": fact["baseline"], "quote": fact["quote"]})
        readings.append({"observation_id": oid, "run_id": run_id, "work": item["work"],
                         "actor": item["actor"], "subject": item["subject"]})
    return observations, sources, facts, readings, unquoted


def ingest_observations(conn, path):
    """Write one run document. The same document again is a no-op; the same run
    id with other content is refused."""
    from psycopg.types.json import Jsonb

    path = Path(path)
    doc = json.loads(path.read_text())
    run_id = path.stem
    run_sha = digest(doc)
    observations, sources, facts, readings, unquoted = build_rows(doc, run_id)
    window = doc.get("window") or {}
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(7543025)")
        old = conn.execute("SELECT run_sha256 FROM observation_runs WHERE run_id = %s", (run_id,)).fetchone()
        if old:
            if old["run_sha256"] != run_sha:
                raise ValueError(f"Observation run {run_id} already ingested with different content")
            return {"run_id": run_id, "reused": True, "observations": len(observations)}
        conn.execute(
            """INSERT INTO observation_runs
               (run_id, extractor, model, prompt_sha256, schema_version, params, window_start, window_end,
                started_at, finished_at, candidate_count, read_count, observation_count, run_sha256)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (run_id, doc["extractor"], doc["model"], doc["prompt_sha256"], doc["schema_version"],
             Jsonb(doc["params"]), window.get("start"), window.get("end"), doc["started_at"],
             doc["finished_at"], doc["candidate_count"], len(doc["read"]), len(observations), run_sha))
        with conn.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO observation_reads (source_id, extractor, run_id) VALUES (%s, %s, %s)
                   ON CONFLICT DO NOTHING""",
                [(source_id, doc["extractor"], run_id) for source_id in doc["read"]])
        new = 0
        for row in observations:
            # The actor's ids only when they are on record; the name is always kept.
            inserted = conn.execute(
                """INSERT INTO observations
                   (observation_id, actor_key, actor_org_id, actor_person_id, actor_name, actor_role,
                    subject_key, work_key, task, evidence_type, outcome, direction, scale, conditions,
                    occurred_on, announced_at, observed_at, extractor, prompt_sha256, model, schema_version)
                   VALUES (%(observation_id)s, %(actor_key)s,
                    (SELECT org_id FROM org_registry WHERE org_id = %(actor_key)s),
                    (SELECT person_id FROM source_accounts WHERE account_key = %(actor_key)s),
                    %(actor_name)s, %(actor_role)s, %(subject_key)s, %(work_key)s, %(task)s,
                    %(evidence_type)s, %(outcome)s, %(direction)s, %(scale)s, %(conditions)s,
                    %(occurred_on)s, %(announced_at)s,
                    (SELECT min(captured_at) FROM collected_captures WHERE source_id = ANY(%(source_ids)s)),
                    %(extractor)s, %(prompt_sha256)s, %(model)s, %(schema_version)s)
                   ON CONFLICT (observation_id) DO NOTHING
                   RETURNING observation_id""", row).fetchone()
            new += inserted is not None
        # An observation merged away by the mapping pass also gives what is found
        # again to the one it was merged into.
        heads = {r["observation_id"]: r["merged_into"] for r in conn.execute(
            "SELECT observation_id, merged_into FROM observation_merges WHERE observation_id = ANY(%s)",
            ([row["observation_id"] for row in observations],)).fetchall()}
        written_sources = sources + [
            {**s, "observation_id": heads[s["observation_id"]],
             "source_ref": "obs-src-" + _short_hash(heads[s["observation_id"]], s["url"])}
            for s in sources if s["observation_id"] in heads]
        written_facts = facts + [
            {**f, "observation_id": heads[f["observation_id"]],
             "fact_id": "fact-" + _short_hash(heads[f["observation_id"]], f["value"], f["unit"], f["what"], f["quote"])}
            for f in facts if f["observation_id"] in heads]
        with conn.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO observation_sources
                   (source_ref, observation_id, source_type, url, source_id, quote, published_at)
                   VALUES (%(source_ref)s, %(observation_id)s, 'x_post', %(url)s, %(source_id)s, %(quote)s,
                    %(published_at)s)
                   ON CONFLICT DO NOTHING""", written_sources)
            cursor.executemany(
                """INSERT INTO observation_facts (fact_id, observation_id, value, unit, what, baseline, quote)
                   VALUES (%(fact_id)s, %(observation_id)s, %(value)s, %(unit)s, %(what)s, %(baseline)s,
                    %(quote)s)
                   ON CONFLICT DO NOTHING""", written_facts)
            cursor.executemany(
                """INSERT INTO observation_readings (observation_id, run_id, work, actor, subject)
                   VALUES (%(observation_id)s, %(run_id)s, %(work)s, %(actor)s, %(subject)s)""", readings)
    return {"run_id": run_id, "reused": False, "read": len(doc["read"]), "observations": len(observations),
            "new_observations": new, "found_again": len(observations) - new, "sources": len(sources),
            "facts": len(facts), "sources_without_quote": unquoted, "refused": doc["refused"],
            "failed_batches": doc["params"]["failed_batches"]}
