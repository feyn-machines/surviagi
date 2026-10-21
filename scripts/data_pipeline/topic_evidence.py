"""Which answers of which topics an update is evidence for, or against.

An update that happens to be in the market a topic is about says nothing about
the topic's question: "OpenAI launches an Agents API" is in software, and is
not evidence that selling software is, or is not, still a business. So an
update reaches a topic only through one of its answers, and a judge says so
(rule:updates-weigh-on-answers-by-judgment).

Two steps per update:

  1. A local embedding picks the few topics the update could be about. The
     score only shortlists; it decides nothing.
  2. Jev is asked, for every answer of those topics independently, whether the
     update supports it, and separately whether it contradicts it. A measured
     result often refutes one answer without proving another: "the model beat
     twelve licensed accountants" contradicts "AI cannot do accounting work",
     and is not by itself evidence that fewer accountants are needed.

The judge is Jev and only Jev (owner decision 2026-10-09). The classifier's
comparison model is a different, looser reader; when Jev cannot be reached, an
update is left unjudged and asked again on the next pass rather than recorded
under another judge.

What is recorded is which way an update weighs on an answer. No answer is
declared right, and nothing here reads or moves an activity level.
"""
from __future__ import annotations

from datetime import datetime, timezone
from secrets import token_hex

from psycopg.types.json import Jsonb

from . import embedding, ontology_schema, topic_mining
from .classify import Classifier, Option
from .ontology_schema import EVENT_KIND_VOCABULARIES
from .pipeline import digest

METHOD_VERSION = "topic-evidence-2"
_RULE = ontology_schema.rule("rule:updates-weigh-on-answers-by-judgment")["expression"]
TOPICS_PER_UPDATE, WEIGHS_ABOVE = _RULE["topics_per_update"], _RULE["weighs_above"]
# Below this an update is not near any topic at all; measured on 418 updates
# against 58 topics, where the nearest topic sat between 0.78 and 0.86.
SHORTLIST_FLOOR = 0.80
JUDGE = _RULE["judge"]
# Updates in a row Jev failed on, from the start of a pass, before the pass gives up.
GIVE_UP_AFTER = 3

_NOT_ENOUGH = "Being about the same field, product or company is not evidence about an answer."
QUESTIONS = {
    "supports": (
        "Is this update evidence that this answer to the question is the true one? It must show "
        "something that makes the answer more likely - a measured result, a real deployment, a "
        "concrete use, a failure. " + _NOT_ENOUGH,
        {"true": "The update shows something that makes this answer more likely to be true.",
         "false": "The update does not make this answer more likely, or is only about the same field."}),
    "contradicts": (
        "Is this update evidence that this answer to the question is NOT the true one? It must show "
        "something that makes the answer less likely - a measured result, a real deployment, a "
        "concrete use, a failure that the answer says does not happen. " + _NOT_ENOUGH,
        {"true": "The update shows something that makes this answer less likely to be true.",
         "false": "The update does not make this answer less likely, or is only about the same field."}),
}
SIGNS = tuple(ontology_schema.term_ids("answer_evidence_sign"))
assert set(SIGNS) == set(QUESTIONS)


def weigh(readings):
    """One row per answer: the way the update weighs on it, when the judge was sure either way.

    `readings` is {sign: {option_id: value}}. An update the judge found both for
    and against the same answer is kept on the side it was surer of.
    """
    kept = {}
    for sign, values in readings.items():
        for option, value in values.items():
            if value > WEIGHS_ABOVE and value > kept.get(option, (None, 0.0))[1]:
                kept[option] = (sign, value)
    return kept


def pending(conn, since=None, limit=None):
    """Updates of the window, newest first; every kind and every actor."""
    clauses, params = ["e.kind_vocabulary = ANY(%s)", "e.kind IS NOT NULL"], [EVENT_KIND_VOCABULARIES]
    if since:
        clauses.append("COALESCE(e.occurred_at, e.announced_at) >= %s")
        params.append(since)
    sql = f"""SELECT e.event_id, e.title, e.summary, e.kind, e.task, e.result
                FROM public.extracted_events e WHERE {' AND '.join(clauses)}
               ORDER BY COALESCE(e.occurred_at, e.announced_at) DESC NULLS LAST, e.event_id"""
    if limit:
        sql += f" LIMIT {int(limit)}"
    return conn.execute(sql, params).fetchall()


def _state(event):
    return {"update": event["title"], "detail": event["summary"], "kind": event["kind"],
            **({"work_done": event["task"]} if event["task"] else {}),
            **({"outcome": event["result"]} if event["result"] else {})}


def shortlist(vector, topic_vectors, checked):
    """The topics nearest an update that it has not been judged against yet."""
    near = embedding.nearest(vector, topic_vectors, TOPICS_PER_UPDATE, floor=SHORTLIST_FLOOR)
    return [topic for topic, _ in near if topic not in checked]


def answers(topic):
    """One option per answer of a topic; the question rides along so an answer reads on its own."""
    return [Option(topic_mining.option_id(topic["id"], o["key"]),
                   f"Question: {topic['question']['en']} Answer: {o['en']}") for o in topic["options"]]


def run(conn, since=None, limit=None, note="", progress=None):
    topics = {t["id"]: t for t in topic_mining.load_topics(conn)}
    events = pending(conn, since, limit)
    counts = {"updates": len(events), "updates_near_a_topic": 0, "pairs_judged": 0, "answers_asked": 0,
              "evidence_rows": 0, **{sign: 0 for sign in SIGNS}, "updates_weighing_on_an_answer": 0, "failed": 0}
    if not topics or not events:
        return {"run_id": None, **counts}
    ids = list(topics)
    topic_vectors = dict(zip(ids, embedding.embed(
        [f"{topics[i]['object']}. {topics[i]['question']['en']}" for i in ids])))
    vectors = embedding.embed([f"{e['title']}. {e['summary'] or ''}" for e in events])
    done = {}
    for row in conn.execute("SELECT event_id, topic_id FROM public.topic_evidence_checked WHERE method_version = %s",
                            (METHOD_VERSION,)).fetchall():
        done.setdefault(row["event_id"], set()).add(row["topic_id"])

    steps = {sign: Classifier(question, criteria, "update", "answer") for sign, (question, criteria) in QUESTIONS.items()}
    primary = steps[SIGNS[0]].primary
    run_id = f"topic-evidence-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{token_hex(3)}"
    conn.execute(
        """INSERT INTO public.judgment_runs
           (run_id, judge, model, task, prompt_sha256, rubric_sha256, method_version,
            params, started_at, status, item_count, decided_count, run_sha256)
           VALUES (%s, 'typesafe', %s, 'answer_evidence', %s, %s, %s, %s, %s, 'running', %s, 0, %s)""",
        (run_id, primary.model, digest({sign: question for sign, (question, _) in QUESTIONS.items()}),
         digest({"criteria": {sign: criteria for sign, (_, criteria) in QUESTIONS.items()},
                 "above": WEIGHS_ABOVE, "floor": SHORTLIST_FLOOR}),
         METHOD_VERSION, Jsonb({"note": note, "topics": len(topics), "since": since}),
         datetime.now(timezone.utc), len(events),
         digest({"events": [e["event_id"] for e in events], "method_version": METHOD_VERSION})))

    stopped = False
    for position, (event, vector) in enumerate(zip(events, vectors), 1):
        near = shortlist(vector, topic_vectors, done.get(event["event_id"], set()))
        if near:
            counts["updates_near_a_topic"] += 1
            options = [option for topic in near for option in answers(topics[topic])]
            owner = {option.id: topic for topic in near for option in answers(topics[topic])}
            readings, by_jev = {}, True
            for sign, step in steps.items():
                failures_before = step.failed_batches + step.fallback_batches
                found = step.classify(_state(event), options, progress)
                counts["answers_asked"] += len(options)
                if step.failed_batches + step.fallback_batches > failures_before or any(r.judge != JUDGE for r in found):
                    by_jev = False
                    break
                readings[sign] = {r.option_id: r.value for r in found}
            if not by_jev:
                # Not judged by Jev: nothing is written, and the next pass asks again.
                counts["failed"] += 1
                if counts["failed"] >= GIVE_UP_AFTER and not counts["pairs_judged"]:
                    # Jev is not answering at all; going on would only spend the comparison model.
                    stopped = True
                    break
            else:
                kept = weigh(readings)
                with conn.transaction():
                    for option, (sign, value) in kept.items():
                        conn.execute(
                            """INSERT INTO public.topic_option_evidence
                               (event_id, option_id, topic_id, sign, confidence, judge, method, status,
                                method_version, judgment_run_id)
                               VALUES (%s, %s, %s, %s, %s, %s, 'ai_proposed', 'candidate', %s, %s)
                               ON CONFLICT (event_id, option_id) DO UPDATE SET
                                 sign = EXCLUDED.sign, confidence = EXCLUDED.confidence,
                                 method_version = EXCLUDED.method_version,
                                 judgment_run_id = EXCLUDED.judgment_run_id
                               WHERE topic_option_evidence.method = 'ai_proposed'""",
                            (event["event_id"], option, owner[option], sign, round(value, 3), JUDGE,
                             METHOD_VERSION, run_id))
                    for topic in near:
                        conn.execute(
                            """INSERT INTO public.topic_evidence_checked (event_id, topic_id, method_version, judgment_run_id)
                               VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                            (event["event_id"], topic, METHOD_VERSION, run_id))
                counts["pairs_judged"] += len(near)
                counts["evidence_rows"] += len(kept)
                for sign in SIGNS:
                    counts[sign] += sum(1 for found, _ in kept.values() if found == sign)
                counts["updates_weighing_on_an_answer"] += bool(kept)
        if progress and position % 50 == 0:
            progress(f"  {position}/{len(events)} updates, {counts['evidence_rows']} evidence rows")

    conn.execute(
        """UPDATE public.judgment_runs SET status = %s, finished_at = %s, decided_count = %s, params = params || %s
            WHERE run_id = %s""",
("failed" if stopped else "completed" if not counts["failed"] else "completed_with_failures",
         datetime.now(timezone.utc),
         counts["answers_asked"], Jsonb(counts), run_id))
    return {"run_id": run_id, **counts, **({"stopped": "Jev could not be reached"} if stopped else {})}
