"""Why an update has no kind: a controlled class over its free-text reason.

Extraction leaves `kind` null and writes a reason when no term fits
(rule:no-other-bucket). The reason explains one row; this pass makes the rows
countable, so "the extractor is stuck" and "the post is a bare link" stop looking
alike (Issue #28). What it picks is a model's proposal for counting: the update
itself does not change, and nothing here gives it a kind.
"""

import hashlib
import json
import time
from datetime import datetime, timezone
from secrets import token_hex

from . import deepseek, ontology_schema
from .event_extraction import NO_KIND_REASON, UNKNOWN_KIND_REASON

VOCABULARY = "event_unresolved_class"
# Written by the extractor itself, so the stored words already say which class it is.
FAULT = "extractor_fault"


def prompt(model=None):
    """The terms come from the vocabulary, so a reworded definition reaches the model."""
    terms = "\n".join(f"- {term}: {ontology_schema.term(VOCABULARY, term, model)['definition']['en']}"
                      for term in ontology_schema.current_term_ids(VOCABULARY, model) if term != FAULT)
    return ("An extractor read a company's post and could not say what kind of update it was. "
            "You are given the title and summary it wrote and its reason. Say why it had no kind.\n\n"
            f"{terms}\n\nReturn JSON: {{\"class\": one of the terms above}}.")


def prompt_sha256(model=None):
    return hashlib.sha256(prompt(model).encode()).hexdigest()


def pending(conn):
    """Updates with no kind that no pass has read yet."""
    return conn.execute("""
        SELECT e.event_id, e.title, e.summary, e.unresolved_reason
        FROM extracted_events e
        WHERE e.kind IS NULL
          AND NOT EXISTS (SELECT 1 FROM event_unresolved_classes c WHERE c.event_id = e.event_id)
        ORDER BY e.event_id
    """).fetchall()


def is_fault(reason):
    return reason == NO_KIND_REASON or (reason or "").startswith(UNKNOWN_KIND_REASON)


def choose(result, model=None):
    """The class a model's answer names; None when it names no term of the vocabulary."""
    value = (result or {}).get("class")
    terms = ontology_schema.current_term_ids(VOCABULARY, model)
    return value if value in terms and value != FAULT else None


def classify(conn, cfg=None, progress=None):
    events = pending(conn)
    counts = {"unresolved": len(events), "classed": 0, "no_term": 0, "failed": 0, "by_class": {}}
    if not events:
        return {"run_id": None, **counts}
    found = []
    needs_model = [e for e in events if not is_fault(e["unresolved_reason"])]
    cfg = cfg or (deepseek.config_from_env() if needs_model else None)
    system = prompt()
    for number, event in enumerate(events, 1):
        if is_fault(event["unresolved_reason"]):
            found.append((event["event_id"], FAULT))
            continue
        user = json.dumps({"title": event["title"], "summary": event["summary"],
                           "reason": event["unresolved_reason"]}, ensure_ascii=False)
        result = None
        for attempt in range(3):
            try:
                result = deepseek.chat([{"role": "system", "content": system},
                                        {"role": "user", "content": user}], cfg)
                break
            except deepseek.DeepSeekError:
                time.sleep(2 * (attempt + 1))
        if result is None:
            # Not read: it stays pending and the next pass asks again.
            counts["failed"] += 1
        else:
            found.append((event["event_id"], choose(result)))
        if progress:
            progress(number, len(events))
    for _, chosen in found:
        if chosen is None:
            counts["no_term"] += 1
        else:
            counts["classed"] += 1
            counts["by_class"][chosen] = counts["by_class"].get(chosen, 0) + 1
    run_id = f"unresolved-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{token_hex(3)}"
    with conn.transaction():
        conn.execute("INSERT INTO event_unresolved_runs (run_id, model, prompt_sha256, counts) VALUES (%s, %s, %s, %s)",
                     (run_id, cfg and cfg["model"], prompt_sha256(), json.dumps(counts)))
        for event_id, chosen in found:
            conn.execute("""
                INSERT INTO event_unresolved_classes (event_id, unresolved_class, run_id) VALUES (%s, %s, %s)
                ON CONFLICT (event_id) DO NOTHING
            """, (event_id, chosen, run_id))
    return {"run_id": run_id, **counts}
