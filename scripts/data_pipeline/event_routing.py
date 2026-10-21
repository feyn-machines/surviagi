"""Route one AI update to the work it bears on, and say how far it goes.

This is the only step whose cost follows the world rather than the catalogue.
The catalogue is static — which occupations do a market's work, which tasks an
activity covers, which gates hold it — and was built once. What changes is that
about nineteen updates arrive per day, and each one has to find its way to the
activities it says something about.

Two calls per update:

  1. Which of the 614 activities does this update bear on? Batched under the
     request ceiling, asked as independent yes/no so a certainty and an explicit
     negative survive.
  2. For the ones it does: what tier is the claim, and how much did a person
     still do?

The old chain asked this through capabilities and lost it: a flagship legal
product was judged against forty-six capabilities, none of which was legal work,
and produced nothing. Asked directly against "Legal document drafting and
checking", it lands.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from secrets import token_hex

from psycopg.types.json import Jsonb

from . import checkpoint
from .classify import Classifier, Option
from .judge import JudgeError, TYPESAFE_URL, _post
from .pipeline import digest
from . import ontology_schema
from .ontology_schema import EVENT_KIND_VOCABULARIES, event_kind_markers

METHOD_VERSION = checkpoint.EVENT_ROUTING
UNROUTED_KIND = ontology_schema.rule("rule:market-measurement-moves-no-level")["expression"]["kind"]

BEARS_ABOVE = 0.6

BEARS_QUESTION = (
    "Does this update show something about whether AI can do this kind of work? "
    "Judge the work itself, not whether the words overlap."
)
BEARS_CRITERIA = {
    "true": "The update is evidence about AI doing this kind of work.",
    "false": "The update says nothing about this kind of work.",
}

# The activity ladder, asked as one reading per activity the update bears on.
# L5 is on the scale and expected to stay empty, which is the point of having it.
LEVEL_QUESTION = (
    "In what this update actually describes, how much of this work did the "
    "software do, and how much did a person still do?"
)
# A score question takes an ordered list: the index is the value, so this list
# IS L0-L5 and its order is load-bearing. Projected from the activity_level
# vocabulary rather than typed here, because a copy of the ladder in the prompt
# can drift from the ladder the answers are recorded against.
LEVEL_SCALE = ontology_schema.level_scale()

TIER_QUESTION = "Who produced this claim, and how checkable is it?"
TIER_SCALE = {
    "T1": "an independent party measured it",
    "T2": "a named adopter reports running it",
    "T3": "the vendor says so, with no outside check",
    "T4": "a demo or a claim with nothing behind it",
}


def events(conn, *, vocabulary: str | None = None,
           limit: int | None = None, exclude: set[str] | None = None) -> list[dict]:
    # Only a company's own updates are routed to work. An update whose actor is
    # a person or a panel organisation is stored, but stays out of the readings
    # until such accounts have their own identity checks.
    clauses = ["e.kind_vocabulary = ANY(%s)", "e.primary_org_id IS NOT NULL",
               # A market measurement says how much a market uses or pays, not how far a
               # piece of work can be done (rule:market-measurement-moves-no-level).
               "e.kind IS DISTINCT FROM %s"]
    params: list = [event_kind_markers(vocabulary), UNROUTED_KIND]
    if exclude:
        # Resume, from the checkpoint table rather than from the evidence rows.
        # Asking "does this event have evidence?" looked equivalent and was not:
        # 325 of 581 events bore on no activity, left no row, and would have been
        # paid for twice.
        clauses.append("NOT (e.event_id = ANY(%s))")
        params.append(list(exclude))
    sql = f"""SELECT e.event_id, e.title, e.summary, e.kind, e.occurred_at,
                     coalesce(o.canonical_name_en, e.primary_org) AS org
                FROM public.extracted_events e
                LEFT JOIN public.org_registry o ON o.org_id = e.primary_org_id
               WHERE {' AND '.join(clauses)}
               ORDER BY e.occurred_at DESC NULLS LAST, e.event_id"""
    if limit:
        sql += f" LIMIT {int(limit)}"
    return conn.execute(sql, params).fetchall()


def activity_options(conn, ontology_version: str) -> list[Option]:
    rows = conn.execute(
        """SELECT w.id, w.label_en, m.label_en AS market
             FROM public.ontology_relations r
             JOIN public.ontology_concepts w
               ON w.id = r.child_id AND w.ontology_version = r.ontology_version
             JOIN public.ontology_concepts m
               ON m.id = r.parent_id AND m.ontology_version = r.ontology_version
            WHERE r.kind = 'has_work' AND r.ontology_version = %s
            ORDER BY m.id, w.id""",
        (ontology_version,),
    ).fetchall()
    # The market rides along because an activity label alone is often ambiguous:
    # "Contract review" means one thing in legal and another in procurement.
    return [Option(row["id"], f"{row['label_en']} ({row['market']})") for row in rows]


def _state(event: dict) -> dict:
    return {
        "update": event["title"],
        "detail": event["summary"],
        **({"published_by": event["org"]} if event["org"] else {}),
        **({"kind": event["kind"]} if event["kind"] else {}),
    }


def read_levels(judge, event: dict, hits: list[tuple[str, str]],
                timeout: int = 300) -> dict[str, dict]:
    """One call: tier for the update, and an autonomy reading per activity."""
    questions = {
        "tier": {"type": "choice", "instructions": TIER_QUESTION,
                 "criteria": dict(TIER_SCALE)},
    }
    for index, (_, label) in enumerate(hits):
        questions[f"level_{index}"] = {
            "type": "score",
            "instructions": {"question": LEVEL_QUESTION, "work": label},
            "criteria": list(LEVEL_SCALE),
        }
    body = _post(TYPESAFE_URL,
                 {"state": _state(event), "model": judge.model, "questions": questions},
                 judge.api_key, timeout)
    answers = body.get("answers") or {}
    tier = str((answers.get("tier") or {}).get("choice") or "T4").strip()
    out = {}
    for index, (activity_id, _) in enumerate(hits):
        score = (answers.get(f"level_{index}") or {}).get("score")
        level = float(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else None
        out[activity_id] = {"tier": tier if tier in {"T1", "T2", "T3", "T4"} else "T4",
                            "level": level}
    return out


def run(conn, *, ontology_version: str = "1.0.0", limit: int | None = None,
        resume: bool = True, note: str = "", progress=None) -> dict:
    options = activity_options(conn, ontology_version)
    # Resume by default: this is the one pass that runs every day, and an event
    # decided yesterday under the same method has nothing new to say today.
    # Changing METHOD_VERSION makes every event due again, which is the right
    # invalidation and needs no cache cleared by hand.
    already = checkpoint.done(conn, METHOD_VERSION) if resume else set()
    rows = events(conn, limit=limit, exclude=already)
    if not options:
        raise ValueError("No activities; nothing to route against")
    skipped = conn.execute(
        """SELECT count(*) AS n FROM public.extracted_events e
            WHERE e.kind_vocabulary = ANY(%s) AND e.primary_org_id IS NOT NULL
              AND e.kind IS DISTINCT FROM %s
              AND EXISTS (SELECT 1 FROM public.judgment_checkpoints c
                           WHERE c.method_version = %s AND c.subject_id = e.event_id)""",
        (EVENT_KIND_VOCABULARIES, UNROUTED_KIND, METHOD_VERSION),
    ).fetchone()["n"] if resume else 0
    if not rows:
        # Everything already decided is a result, not an error: the daily run
        # reaches this the moment no new update has arrived.
        return {"run_id": None, "events": 0, "events_skipped": skipped,
                "questions_asked": 0, "evidence_rows": 0, "events_bearing_nothing": 0,
                "events_incomplete": 0, "fallback_batches": 0, "failed_batches": 0,
                "elapsed_seconds": 0.0}

    step = Classifier(BEARS_QUESTION, BEARS_CRITERIA, "update", "work")
    by_id = {option.id: option.label for option in options}
    run_id = f"route-event-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{token_hex(3)}"
    started = datetime.now(timezone.utc)
    conn.execute(
        """INSERT INTO public.judgment_runs
           (run_id, judge, model, task, prompt_sha256, rubric_sha256, method_version,
            params, started_at, status, item_count, decided_count, run_sha256)
           VALUES (%s, 'typesafe', %s, 'demonstrates', %s, %s, %s, %s, %s, 'running', %s, 0, %s)""",
        (run_id, step.primary.model,
         digest({"bears": BEARS_QUESTION, "level": LEVEL_QUESTION, "tier": TIER_QUESTION}),
         digest({"levels": LEVEL_SCALE, "tiers": TIER_SCALE, "above": BEARS_ABOVE}),
         METHOD_VERSION,
         Jsonb({"note": note, "bears_above": BEARS_ABOVE, "activities": len(options),
                "events": len(rows), "events_skipped": skipped, "resume": resume}),
         started, len(rows),
         digest({"events": [r["event_id"] for r in rows], "method_version": METHOD_VERSION})),
    )

    asked = kept = silent = incomplete = 0
    for position, event in enumerate(rows, 1):
        failures_before = step.failed_batches
        readings = step.classify(_state(event), options, progress)
        asked += len(options)
        # Each reading keeps the judge that gave it: Jev, or the comparison model
        # when Jev failed (a region block once answered every batch that way).
        hits = [(r.option_id, by_id[r.option_id], r.value, r.judge)
                for r in readings if r.value > BEARS_ABOVE]
        here = 0
        levels_read = True
        if hits:
            try:
                levels = read_levels(step.primary, event, [(a, label) for a, label, _, _ in hits])
            except JudgeError as error:
                # Evidence with no level contributes nothing downstream, so this
                # event is half-decided: it is neither checkpointed nor written,
                # since a written row would block the retry's (ON CONFLICT DO NOTHING).
                if progress:
                    progress(f"  level read failed for {event['event_id']}: {error}")
                levels, levels_read = {}, False
            for activity_id, label, value, judge in hits if levels_read else []:
                detail = levels.get(activity_id) or {}
                row = {
                    "event_id": event["event_id"],
                    "activity_id": activity_id,
                    "ontology_version": ontology_version,
                    "evidence_tier": detail.get("tier") or "T4",
                    "evidence_sign": "positive",
                    "observed_level": detail.get("level"),
                    "confidence": round(value, 3),
                    "judge": judge,
                    "method": "ai_proposed",
                    "status": "candidate",
                    "rationale": f"bears={value:.3f} on «{label}»",
                    "judgment_run_id": run_id,
                    "reviewed_by": None,
                    "reviewed_at": None,
                }
                row["record_sha256"] = digest(row)
                columns = list(row)
                conn.execute(
                    f"""INSERT INTO public.activity_evidence ({', '.join(columns)})
                        VALUES ({', '.join(['%s'] * len(columns))})
                        ON CONFLICT (event_id, activity_id) DO NOTHING""",
                    [row[c] for c in columns],
                )
                here += 1
        else:
            # An update that bears on nothing is the ordinary case, and it is a
            # finding rather than a gap: recorded so the ratio stays visible.
            silent += 1
        kept += here
        if levels_read and checkpoint.completed(step.failed_batches, failures_before):
            checkpoint.mark(conn, METHOD_VERSION, event["event_id"], run_id,
                            here, len(options))
        else:
            incomplete += 1
        if progress and position % 25 == 0:
            progress(f"  {position}/{len(rows)} events, {kept} evidence rows")

    failed = step.failed_batches
    conn.execute(
        """UPDATE public.judgment_runs
              SET status = %s, finished_at = %s, decided_count = %s, params = params || %s
            WHERE run_id = %s""",
        ("completed" if failed == 0 and incomplete == 0 else "completed_with_failures",
         datetime.now(timezone.utc), asked,
         Jsonb({"fallback_batches": step.fallback_batches, "failed_batches": failed,
                "events_bearing_nothing": silent, "events_incomplete": incomplete}), run_id),
    )
    return {
        "run_id": run_id, "events": len(rows), "events_skipped": skipped,
        "questions_asked": asked, "evidence_rows": kept,
        "events_bearing_nothing": silent, "events_incomplete": incomplete,
        "fallback_batches": step.fallback_batches, "failed_batches": failed,
        "elapsed_seconds": round(time.time() - started.timestamp(), 1),
    }
