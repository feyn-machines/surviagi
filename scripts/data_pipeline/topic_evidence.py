"""Which answers of which topics an observation is evidence for, or against.

An observation that happens to be about the occupation or market a topic is
about says nothing about the topic's question: "an agent drafted 40 support
replies" is about customer service, and is not evidence that customer service
jobs are, or are not, going away. So an observation reaches a topic only
through one of its answers, and a judge says so
(rule:observations-weigh-on-answers-by-judgment). It replaces the same step for
updates (rule:updates-weigh-on-answers-by-judgment); those rows stay, and are
no longer written.

Two steps per observation:

  1. A local embedding picks the few topics the observation could be about. The
     score only shortlists; it decides nothing.
  2. Jev is asked, for every answer of those topics independently, whether the
     observation supports it, and separately whether it contradicts it. A
     measured result often refutes one answer without proving another: "the
     model beat twelve licensed accountants" contradicts "AI cannot do
     accounting work", and is not by itself evidence that fewer accountants
     are needed.

The judge is Jev and only Jev (owner decision 2026-10-09). The classifier's
comparison model is a different, looser reader; when Jev cannot be reached, an
observation is left unjudged and asked again on the next pass rather than
recorded under another judge.

What is recorded is which way an observation weighs on an answer. No answer is
declared right.
"""
from __future__ import annotations

from datetime import datetime, timezone
from secrets import token_hex

from psycopg.types.json import Jsonb

from . import embedding, ontology_schema, topic_mining
from .classify import Classifier, Option
from .pipeline import digest

METHOD_VERSION = "topic-evidence-3"
_RULE = ontology_schema.rule("rule:observations-weigh-on-answers-by-judgment")["expression"]
TOPICS_PER_OBSERVATION, WEIGHS_ABOVE = _RULE["topics_per_observation"], _RULE["weighs_above"]
# Below this an observation is not near any topic at all; measured on 418 updates
# against 58 topics, where the nearest topic sat between 0.78 and 0.86.
SHORTLIST_FLOOR = 0.80
JUDGE = _RULE["judge"]
# Observations in a row Jev failed on, from the start of a pass, before the pass gives up.
GIVE_UP_AFTER = 3

_NOT_ENOUGH = "Being about the same occupation, market, product or company is not evidence about an answer."
QUESTIONS = {
    "supports": (
        "Is this observation evidence that this answer to the question is the true one? It must show "
        "something that makes the answer more likely - a measured result, a real deployment, a "
        "concrete use, a failure. " + _NOT_ENOUGH,
        {"true": "The observation shows something that makes this answer more likely to be true.",
         "false": "The observation does not make this answer more likely, or is only about the same field."}),
    "contradicts": (
        "Is this observation evidence that this answer to the question is NOT the true one? It must show "
        "something that makes the answer less likely - a measured result, a real deployment, a "
        "concrete use, a failure that the answer says does not happen. " + _NOT_ENOUGH,
        {"true": "The observation shows something that makes this answer less likely to be true.",
         "false": "The observation does not make this answer less likely, or is only about the same field."}),
}
SIGNS = tuple(ontology_schema.term_ids("answer_evidence_sign"))
assert set(SIGNS) == set(QUESTIONS)
# The longest source words put to the judge and the embedding: enough to say what happened.
QUOTE_CHARS = 600


def weigh(readings):
    """One row per answer: the way the observation weighs on it, when the judge was sure either way.

    `readings` is {sign: {option_id: value}}. An observation the judge found both for
    and against the same answer is kept on the side it was surer of.
    """
    kept = {}
    for sign, values in readings.items():
        for option, value in values.items():
            if value > WEIGHS_ABOVE and value > kept.get(option, (None, 0.0))[1]:
                kept[option] = (sign, value)
    return kept


def pending(conn, since=None, limit=None):
    """Observations to read, newest first: the ones that stand (not merged into another) and no person rejected.

    `since` limits to those recorded on or after a time. A pair already judged is skipped later,
    so leaving it out is how a topic opened today meets the observations of last week.
    """
    clauses = ["o.review_state <> 'human_rejected'",
               "NOT EXISTS (SELECT 1 FROM public.observation_merges m WHERE m.observation_id = o.observation_id)"]
    params = []
    if since:
        clauses.append("o.created_at >= %s")
        params.append(since)
    sql = f"""SELECT o.observation_id, o.task, o.evidence_type, o.outcome, o.direction, o.actor_role,
                     o.scale, o.conditions,
                     COALESCE(org.canonical_name_en, o.actor_name) AS actor,
                     COALESCE(p.name, mo.name, o.subject_key) AS subject,
                     (SELECT string_agg(left(s.quote, {QUOTE_CHARS}), ' | ' ORDER BY s.published_at, s.source_ref)
                        FROM public.observation_sources s WHERE s.observation_id = o.observation_id) AS quote,
                     (SELECT string_agg(f.value || COALESCE(' ' || f.unit, '') || ' ' || f.what, '; ' ORDER BY f.fact_id)
                        FROM public.observation_facts f WHERE f.observation_id = o.observation_id) AS facts
                FROM public.observations o
                LEFT JOIN public.org_registry org ON org.org_id = o.actor_org_id
                LEFT JOIN public.products p ON p.product_id = o.subject_product_id
                LEFT JOIN public.models mo ON mo.model_id = o.subject_model_id
               WHERE {' AND '.join(clauses)}
               ORDER BY COALESCE(o.occurred_on::timestamptz, o.announced_at) DESC NULLS LAST, o.observation_id"""
    if limit:
        sql += f" LIMIT {int(limit)}"
    return conn.execute(sql, params).fetchall()


def _state(observation):
    """What the judge reads: what was done, by whom, with what, how it came out, and the source words."""
    return {key: value for key, value in {
        "work_done": observation["task"], "who": observation["actor"], "role": observation["actor_role"],
        "used": observation["subject"], "basis": observation["evidence_type"], "outcome": observation["outcome"],
        "scale": observation["scale"], "conditions": observation["conditions"], "figures": observation["facts"],
        "source_words": observation["quote"]}.items() if value}


def _text(observation):
    """What the embedding reads: the work and the words, which is what a topic's question is about."""
    return f"{observation['task']}. {observation['quote'] or ''}"[:QUOTE_CHARS + 200]


def shortlist(vector, topic_vectors, checked):
    """The topics nearest an observation that it has not been judged against yet."""
    near = embedding.nearest(vector, topic_vectors, TOPICS_PER_OBSERVATION, floor=SHORTLIST_FLOOR)
    return [topic for topic, _ in near if topic not in checked]


def answers(topic):
    """One option per answer of a topic; the question rides along so an answer reads on its own."""
    return [Option(topic_mining.option_id(topic["id"], o["key"]),
                   f"Question: {topic['question']['en']} Answer: {o['en']}") for o in topic["options"]]


def run(conn, since=None, limit=None, note="", progress=None):
    topics = {t["id"]: t for t in topic_mining.load_topics(conn)}
    rows = pending(conn, since, limit)
    counts = {"observations": len(rows), "observations_near_a_topic": 0, "pairs_judged": 0, "answers_asked": 0,
              "evidence_rows": 0, **{sign: 0 for sign in SIGNS}, "observations_weighing_on_an_answer": 0, "failed": 0}
    if not topics or not rows:
        return {"run_id": None, **counts}
    ids = list(topics)
    topic_vectors = dict(zip(ids, embedding.embed(
        [f"{topics[i]['object']}. {topics[i]['question']['en']}" for i in ids])))
    vectors = embedding.embed([_text(r) for r in rows])
    done = {}
    for row in conn.execute("SELECT observation_id, topic_id FROM public.topic_observation_checked WHERE method_version = %s",
                            (METHOD_VERSION,)).fetchall():
        done.setdefault(row["observation_id"], set()).add(row["topic_id"])

    steps = {sign: Classifier(question, criteria, "observation", "answer") for sign, (question, criteria) in QUESTIONS.items()}
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
         datetime.now(timezone.utc), len(rows),
         digest({"observations": [r["observation_id"] for r in rows], "method_version": METHOD_VERSION})))

    stopped = False
    for position, (observation, vector) in enumerate(zip(rows, vectors), 1):
        near = shortlist(vector, topic_vectors, done.get(observation["observation_id"], set()))
        if near:
            counts["observations_near_a_topic"] += 1
            options = [option for topic in near for option in answers(topics[topic])]
            owner = {option.id: topic for topic in near for option in answers(topics[topic])}
            readings, by_jev = {}, True
            for sign, step in steps.items():
                failures_before = step.failed_batches + step.fallback_batches
                found = step.classify(_state(observation), options, progress)
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
                            """INSERT INTO public.topic_option_observations
                               (observation_id, option_id, topic_id, sign, confidence, judge, method, status,
                                method_version, judgment_run_id)
                               VALUES (%s, %s, %s, %s, %s, %s, 'ai_proposed', 'candidate', %s, %s)
                               ON CONFLICT (observation_id, option_id) DO UPDATE SET
                                 sign = EXCLUDED.sign, confidence = EXCLUDED.confidence,
                                 method_version = EXCLUDED.method_version,
                                 judgment_run_id = EXCLUDED.judgment_run_id
                               WHERE topic_option_observations.method = 'ai_proposed'""",
                            (observation["observation_id"], option, owner[option], sign, round(value, 3), JUDGE,
                             METHOD_VERSION, run_id))
                    for topic in near:
                        conn.execute(
                            """INSERT INTO public.topic_observation_checked (observation_id, topic_id, method_version, judgment_run_id)
                               VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                            (observation["observation_id"], topic, METHOD_VERSION, run_id))
                counts["pairs_judged"] += len(near)
                counts["evidence_rows"] += len(kept)
                for sign in SIGNS:
                    counts[sign] += sum(1 for found, _ in kept.values() if found == sign)
                counts["observations_weighing_on_an_answer"] += bool(kept)
        if progress and position % 50 == 0:
            progress(f"  {position}/{len(rows)} observations, {counts['evidence_rows']} evidence rows")

    conn.execute(
        """UPDATE public.judgment_runs SET status = %s, finished_at = %s, decided_count = %s, params = params || %s
            WHERE run_id = %s""",
        ("failed" if stopped else "completed" if not counts["failed"] else "completed_with_failures",
         datetime.now(timezone.utc),
         counts["answers_asked"], Jsonb(counts), run_id))
    return {"run_id": run_id, **counts, **({"stopped": "Jev could not be reached"} if stopped else {})}
