"""Which market or occupation a market measurement is about.

A market measurement - "98% of US households are not paying for AI yet" - is
an update about a market, not about one company's product. It is never routed
to work and moves no level (rule:market-measurement-moves-no-level). This pass
hangs each one on the catalog entries it measures, so it can be read beside
that market and under the topics about it.

A local embedding shortlists the catalog entries worth showing; a model picks
among them, or none. What it picks is a proposal and stays a candidate.
"""

import json
import time
from datetime import datetime, timezone
from secrets import token_hex

from . import deepseek, embedding, ontology_schema

KIND = ontology_schema.rule("rule:market-measurement-moves-no-level")["expression"]["kind"]
SHORTLIST, MAX_ENTRIES = 12, 2

PROMPT = """A third party published a measurement of a market or of work. Say which entries of our catalog it measures.

You are given the measurement and a shortlist of catalog entries, one per line as `id | name`. Occupations are jobs people hold; markets are kinds of products and services.

Pick the entries the measurement is actually about - the market whose use, spending or ranking it counts, or the occupation whose employment or hiring it counts. Pick at most 2, and pick none when the measurement is about AI in general, the whole economy, or something the shortlist does not contain. A wrong match is worse than none.

Return JSON: {"entries": [{"id": an id from the shortlist, "why": a few words}]}."""


def pending(conn):
    """Market measurements no pass has looked at yet."""
    return conn.execute("""
        SELECT e.event_id, e.title, e.summary, e.subject
        FROM extracted_events e
        WHERE e.kind = %s
          AND NOT EXISTS (SELECT 1 FROM event_measure_checked c WHERE c.event_id = e.event_id)
        ORDER BY e.event_id
    """, (KIND,)).fetchall()


def catalog(conn):
    rows = conn.execute("""
        SELECT id, label_en FROM ontology_concepts
        WHERE kind IN ('occupation', 'market', 'market_group')
          AND ontology_version = (SELECT max(ontology_version) FROM ontology_concepts)
        ORDER BY id
    """).fetchall()
    return {r["id"]: r["label_en"] for r in rows}


def choose(result, offered):
    """The entries a model's answer names, kept only when they were on the shortlist."""
    picked, seen = [], set()
    for entry in (result or {}).get("entries") or []:
        if isinstance(entry, dict) and entry.get("id") in offered and entry["id"] not in seen:
            seen.add(entry["id"])
            picked.append({"id": entry["id"], "why": str(entry.get("why") or "")[:200]})
    return picked[:MAX_ENTRIES]


def link(conn, cfg=None, progress=None):
    cfg = cfg or deepseek.config_from_env()
    events = pending(conn)
    entries = catalog(conn)
    run_id = f"measure-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{token_hex(3)}"
    counts = {"measurements": len(events), "linked": 0, "links": 0, "about_nothing_in_catalog": 0, "failed": 0}
    if not events:
        return {"run_id": None, **counts}
    ids = list(entries)
    vectors = dict(zip(ids, embedding.embed([entries[i] for i in ids])))
    texts = [f"{e['title']}. {e['summary'] or ''}" for e in events]
    found = []
    for number, (event, vector) in enumerate(zip(events, embedding.embed(texts)), 1):
        offered = [cid for cid, _ in embedding.nearest(vector, vectors, SHORTLIST)]
        user = ("Measurement:\n" + json.dumps({"title": event["title"], "summary": event["summary"],
                                               "source": event["subject"]}, ensure_ascii=False)
                + "\n\nShortlist:\n" + "\n".join(f"{cid} | {entries[cid]}" for cid in offered))
        result = None
        for attempt in range(3):
            try:
                result = deepseek.chat([{"role": "system", "content": PROMPT},
                                        {"role": "user", "content": user}], cfg)
                break
            except deepseek.DeepSeekError:
                time.sleep(2 * (attempt + 1))
        if result is None:
            # Not looked at: it stays pending and the next pass asks again.
            counts["failed"] += 1
        else:
            picked = choose(result, set(offered))
            found.append((event["event_id"], picked))
            counts["linked" if picked else "about_nothing_in_catalog"] += 1
            counts["links"] += len(picked)
        if progress:
            progress(number, len(events))
    with conn.transaction():
        conn.execute("INSERT INTO event_measure_runs (run_id, model, embedding_model, counts) VALUES (%s, %s, %s, %s)",
                     (run_id, cfg["model"], embedding.config_from_env()["model"], json.dumps(counts)))
        for event_id, picked in found:
            conn.execute("INSERT INTO event_measure_checked (event_id, run_id) VALUES (%s, %s)", (event_id, run_id))
            for entry in picked:
                conn.execute("""
                    INSERT INTO event_measures (event_id, concept_id, method, status, rationale, run_id)
                    VALUES (%s, %s, 'ai_proposed', 'candidate', %s, %s) ON CONFLICT DO NOTHING
                """, (event_id, entry["id"], entry["why"], run_id))
    return {"run_id": run_id, **counts}
