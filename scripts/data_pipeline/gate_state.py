"""Whether anything published has moved a gate, and a dated record either way.

A gate is closed by definition - that is what makes it a gate - so the useful
question is never "is it closed?" but "has anything changed it, and when did we
last look?". A gate with no state row is indistinguishable from a gate nobody
has checked; a row saying "closed, nothing in this window moved it, as of this
date" is a finding.

Only policy statements are read here. A gate lifts when an institution changes
its rules, not when a model gets better, so a benchmark result is not evidence
about a gate no matter how strong it is.
"""
from __future__ import annotations

import sys
import time
from datetime import datetime, timezone

from psycopg.types.json import Jsonb

from . import ontology_schema
from .judge import JudgeError, TypeSafeJudge, _post, TYPESAFE_URL, METHOD_VERSION
from .pipeline import digest

STATE_LOCK = 7543013

GATE_MOVE_QUESTION = (
    "You are deciding whether a published statement changes a blocking condition "
    "that currently stops work from being done without a person.\n"
    "Only an institution changing its own rules can move such a condition: a "
    "regulator permitting something previously required of a person, an employer "
    "removing a sign-off, a professional body accepting an automated result.\n"
    "A statement of intent, a safety commitment, a research finding or a product "
    "capability does not move it, however impressive. Saying a system is now good "
    "enough is not the same as anyone deciding it may be used unsupervised."
)

STATUS_CRITERIA = {
    "closed": "Nothing here changes the condition; it still blocks.",
    "partially_open": "The condition is relaxed for some cases, parties or places, "
                      "but not generally.",
    "open": "The condition no longer blocks: the requirement has been lifted.",
}


def load_policy_events(conn, vocabulary: str | None = None) -> list[dict]:
    clause = "e.kind = 'policy_statement' AND e.primary_org_id IS NOT NULL AND e.kind_vocabulary = ANY(%s)"
    params: list = [ontology_schema.event_kind_markers(vocabulary)]
    with conn.cursor() as cursor:
        cursor.execute(
            f"""SELECT e.event_id, e.title, e.summary, e.occurred_at,
                       coalesce(o.canonical_name_en, e.primary_org) AS org
                FROM public.extracted_events e
                LEFT JOIN public.org_registry o ON o.org_id = e.primary_org_id
                WHERE {clause}
                ORDER BY e.occurred_at DESC NULLS LAST""", params)
        return cursor.fetchall()


def load_gates(conn) -> list[dict]:
    with conn.cursor() as cursor:
        cursor.execute(
            """SELECT gate_id, gate_type, label_en, definition_en
               FROM public.gates WHERE lifecycle = 'active' ORDER BY gate_id""")
        return cursor.fetchall()


def compute(conn, vocabulary: str | None = None, progress=None) -> dict:
    say = progress or (lambda message: print(message, file=sys.stderr, flush=True))
    judge = TypeSafeJudge()
    gates = load_gates(conn)
    if not gates:
        raise ValueError("No active gates; run seed-ontology-data first")
    events = load_policy_events(conn, vocabulary)
    say(f"{len(gates)} gates against {len(events)} policy statements")

    started = datetime.now(timezone.utc)
    run_id = f"judge-typesafe-gatestate-{started.strftime('%Y%m%dT%H%M%SZ')}"
    moves: dict[str, list[dict]] = {g["gate_id"]: [] for g in gates}
    judged = 0

    for event in events:
        questions = {}
        for index, gate in enumerate(gates):
            questions[f"status_{index}"] = {
                "type": "choice",
                "instructions": {"question": GATE_MOVE_QUESTION, "condition": {
                    "name": gate["label_en"], "definition": gate["definition_en"],
                    "kind": gate["gate_type"]}},
                "criteria": dict(STATUS_CRITERIA),
            }
        state = {"statement": event["title"], "detail": event["summary"],
                 "published_by": event["org"] or "unknown"}
        try:
            body = _post(TYPESAFE_URL, {"state": state, "model": judge.model,
                                        "questions": questions}, judge.api_key, 60)
        except JudgeError as error:
            say(f"  {event['event_id']}: {error}")
            continue
        answers = body.get("answers") or {}
        for index, gate in enumerate(gates):
            answer = answers.get(f"status_{index}") or {}
            status = answer.get("choice")
            judged += 1
            if status in ("partially_open", "open"):
                moves[gate["gate_id"]].append({
                    "event_id": event["event_id"], "status": status,
                    "confidence": answer.get("confidence"), "title": event["title"]})
        time.sleep(0.1)

    as_of = datetime.now(timezone.utc)
    states = []
    for gate in gates:
        found = moves[gate["gate_id"]]
        if not found:
            states.append({
                "gate_id": gate["gate_id"], "as_of": as_of, "method_version": METHOD_VERSION,
                "status": "closed", "source_event_id": None,
                "rationale": (
                    f"Checked against {len(events)} published policy statement(s); none of "
                    f"them changes this condition. A gate stays closed until an institution "
                    f"changes its own rule, so this is the expected result, not a gap."),
            })
            continue
        strongest = max(found, key=lambda m: (m["status"] == "open", m["confidence"] or 0))
        states.append({
            "gate_id": gate["gate_id"], "as_of": as_of, "method_version": METHOD_VERSION,
            "status": strongest["status"], "source_event_id": strongest["event_id"],
            "rationale": (
                f"{len(found)} statement(s) judged to move this condition; strongest: "
                f"{strongest['title']}. Machine-judged and unreviewed."),
        })

    with conn.transaction(), conn.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", (STATE_LOCK,))
        cursor.execute(
            """INSERT INTO public.judgment_runs
               (run_id, judge, model, task, prompt_sha256, rubric_sha256, method_version,
                params, started_at, finished_at, status, item_count, decided_count, run_sha256)
               VALUES (%s, 'typesafe', %s, 'gate_state', %s, %s, %s, %s, %s, %s,
                       'completed', %s, %s, %s)""",
            (run_id, judge.model, digest({"question": GATE_MOVE_QUESTION}),
             digest(STATUS_CRITERIA), METHOD_VERSION,
             Jsonb({"subject": "gate_state", "policy_events": len(events),
                    "gates": [g["gate_id"] for g in gates], "vocabulary": vocabulary}),
             started, as_of, len(gates) * len(events), judged,
             digest({"run": run_id, "states": [(s["gate_id"], s["status"]) for s in states]})))
        for state in states:
            payload = {k: (v.isoformat() if isinstance(v, datetime) else v)
                       for k, v in state.items()}
            cursor.execute(
                """INSERT INTO public.gate_states
                   (gate_id, as_of, method_version, status, rationale, source_event_id,
                    record_sha256)
                   VALUES (%(gate_id)s, %(as_of)s, %(method_version)s, %(status)s,
                           %(rationale)s, %(source_event_id)s, %(record_sha256)s)
                   ON CONFLICT (gate_id, as_of, method_version) DO NOTHING""",
                {**state, "record_sha256": digest(payload)})

    return {"run_id": run_id, "gates": len(gates), "policy_events": len(events),
            "judgments": judged,
            "closed": sum(1 for s in states if s["status"] == "closed"),
            "moved": sum(1 for s in states if s["status"] != "closed"),
            "states": [{k: v for k, v in s.items() if k != "as_of"} for s in states]}
