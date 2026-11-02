"""Observations read from posts (Issue #25, ontology 2.5.0).

An observation is one actor using one subject on one piece of work, how it came
out, on what basis, and where it is written
(rule:observation-is-one-actor-one-subject-one-work). They are read in a
call of their own, `deepseek.extract_observations`, next to the update call:
asked in the same call, the model traded updates for observations. This module
is the deterministic part around that call:

  prefilter            (pure: which posts are worth a call at all)
  system_prompt        (pure: the instructions, rendered from the schema)
  assemble_observations (pure: model output -> checked, merged observations)

A quote the post does not contain refuses the observation, and a fact whose
quote is not there is dropped (rule:observation-quotes-are-found-in-the-source).
Work stays the model's own words here: mapping it to catalog entries is a later
pass (rule:work-mapping-stays-a-candidate), so `work_key` is 'unmapped' and the
identity uses the words until that pass runs. Nothing here writes the database:
`observation_store` does.
"""
from __future__ import annotations

import hashlib
import re

from . import ontology_schema
from .event_extraction import _iso, _slug, _text_or_none, quoted_in, resolve_org

EXTRACTOR = "observation-extraction-3"
# -2: more posts are read as observations (a person's own use without numbers,
# an agent doing something it was not asked to), the actor's role follows who
# makes the subject, and a value is written without its unit. On the 500-post
# sample of 2026-11-03, -1 found 18 and missed own-use and failure reports.
# -3: a call of its own instead of a section of the update prompt.

ACTOR_ROLES = frozenset(ontology_schema.term_ids("observation_actor_role"))
EVIDENCE_TYPES = frozenset(ontology_schema.term_ids("event_basis"))
OUTCOMES = frozenset(ontology_schema.term_ids("event_result"))
DIRECTIONS = frozenset(ontology_schema.term_ids("observation_direction"))

# Posts that cannot carry an observation, so are not sent. Reposts and replies
# are already left out by load_candidates. A relay passes on someone else's
# words (rule:relays-are-not-a-source); a post with almost no words of its own
# once links, mentions and hashtags are taken out states nothing to observe.
# A Chinese or Japanese character says about as much as two Latin letters, so
# it counts twice.
MIN_OWN_CHARACTERS = 40
_NOT_OWN_WORDS = re.compile(r"https?://\S+|[@#][\w.]+")
_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")


def own_words(text):
    return " ".join(_NOT_OWN_WORDS.sub(" ", text or "").split())


def own_length(text):
    words = own_words(text)
    return len(words) + len(_CJK.findall(words))


def prefilter(candidate):
    """Why this post is not worth reading for observations, or None to read it."""
    if candidate.get("relay"):
        return "relay"
    if own_length(candidate.get("text") or candidate.get("excerpt")) < MIN_OWN_CHARACTERS:
        return "too_short"
    return None


def system_prompt(schema=None):
    """The observation prompt, with its vocabularies rendered from the schema."""
    schema = schema or ontology_schema.load_schema()

    def choices(name):
        terms = schema["vocabularies"][name]["terms"]
        return [f"  - {term_id}: {body['definition']['en']}" for term_id, body in terms.items()]

    return "\n".join([
        "You read posts about AI from companies, organizations and individual people, and return "
        "OBSERVATIONS: what the posts show about AI doing real work that people are paid for. One observation is ONE "
        "actor using ONE AI product or model on ONE piece of work, how it came out, and on what basis. "
        "A post gives zero, one or several. Return [] when none does.",
        "- It is an observation when a post says that AI did, helped with, failed at or was measured "
        "on a concrete piece of work. Look for all six kinds in every post; one is not more important "
        "than another:",
        "  1. a company saying what its own product does on a named piece of work, e.g. \"it reconciles "
        "two tables line by line\" (vendor_claim, or demonstration when it shows an example);",
        "  2. a named organization using AI in its operations or a study run inside one, e.g. a "
        "hospital, a bank, a retailer (production_use);",
        "  3. a person reporting their own use (own_use, see below);",
        "  4. a test or benchmark by someone other than the maker on named work, e.g. a legal or "
        "coding benchmark, a lab study (measurement);",
        "  5. an institution's count of adoption, spending, hiring or employment, including one quoted "
        "by someone else (statistic);",
        "  6. a failure, limit or incident of any of the above.",
        "- A person who says they used an AI tool to make or do something specific - built an app, "
        "wrote a report, made a design or a video, analysed data, handled email - IS an observation "
        "(own_use), even with no number, even for a side project, and even when the post also gives an "
        "opinion. Someone they name (a colleague, a spouse, a team) using it is the same, with that "
        "person as actor.",
        "- Failures, rollbacks, limits, incidents, an agent doing something it was not asked to (spending "
        "money, deleting files, acting without asking), a person still being needed, and \"tried it and "
        "it did not work\" are observations exactly as much as successes. Their direction is "
        "human_still_needed, and an agent acting without being asked has outcome partly or failed "
        "even when the action itself went through.",
        "- NOT an observation: a feature list with no work and no result, a price or a release date "
        "alone, a benchmark leaderboard rank with no work named, a tutorial or list of tips telling "
        "others what they could do, a prediction, hype, or opinion about AI in general.",
        "- A relay or a retelling of someone else's result keeps the original actor; the post is "
        "only where it is written.",
        "- Several actors, subjects or pieces of work in one post are several observations. The same "
        "actor, subject and work told by several posts is ONE observation listing every post.",
        "Each observation:",
        '- "source_ids": the given post ids it is read from (at least one)',
        '- "actor": who did it or claims it, as the post names them (a company, organization or person; '
        "the post's author when they report their own use)",
        '- "actor_role": the actor\'s relation to the subject - maker whenever the actor makes the '
        "subject, even when it uses it itself or shows a demo; an unnamed adopter retold by someone "
        "else is still an adopter, with actor written as the post describes them. One of",
        *choices("observation_actor_role"),
        '- "subject": the AI product or model as the post names it, or null when it names none',
        '- "work": the occupation or line of work in a few plain words ("accounting", "customer '
        'support", "software development", "legal research")',
        '- "task": ONE plain sentence of what the AI was given to do, understandable to a non-engineer',
        '- "evidence_type": on what basis it is known, one of',
        *choices("event_basis"),
        '- "outcome": one of',
        *choices("event_result"),
        '- "direction": one of',
        *choices("observation_direction"),
        '- "facts": array of {"value", "unit", "what", "baseline", "quote"} - each number the '
        'observation rests on; "value" the number alone ("20", "4.80", "~4"), "unit" separately '
        '("minutes", "USD", "% per year"); "baseline" what it is compared with or null; "quote" '
        'copied EXACTLY',
        '- "scale": users, volume, staff or coverage as the post states it, or null',
        '- "conditions": human oversight, pilot scope, region, limits or failure mode as stated, or null',
        '- "occurred_at": ISO 8601 UTC timestamp of when it happened, or null',
        '- "quote": the sentence of the post that states it, copied EXACTLY',
        "Return STRICT JSON, an object: {\"observations\": [...]}. Use only the given posts as "
        "evidence. Never invent an actor, a number or an outcome: \"not_stated\" and null are "
        "correct answers. Output ONLY the JSON object.",
    ])


def observation_id(actor_key, subject_key, work_key, occurred_on):
    """'obs-' and a hash of the identity fields (schema Observation.observation_id)."""
    identity = "\n".join([actor_key, subject_key, work_key, occurred_on or ""])
    return "obs-" + hashlib.sha256(identity.encode()).hexdigest()[:16]


def actor_key(name, posts):
    """An org id, the author's account when they name themselves, else the name unresolved."""
    org = resolve_org(name)
    if org:
        return org
    wanted = _slug(name.lstrip("@"))
    for post in posts:
        if wanted and wanted == _slug(post.get("handle") or "") and post.get("account_key"):
            return post["account_key"]
    return "unresolved:" + (wanted or "unknown")


def _facts(raw, texts):
    kept, refused = [], 0
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            refused += 1
            continue
        value = None if item.get("value") is None else str(item["value"]).strip()
        what = _text_or_none(item.get("what"))
        source_id = quoted_in(item.get("quote"), texts)
        if not value or not what or not source_id:
            refused += 1
            continue
        fact = {"value": value, "unit": _text_or_none(item.get("unit")), "what": what,
                "baseline": _text_or_none(item.get("baseline")), "quote": item["quote"].strip(),
                "source_id": source_id}
        if fact not in kept:
            kept.append(fact)
    return kept, refused


def check_observation(raw, by_id):
    """(observation, None) when the model's item holds, else (None, reason)."""
    if not isinstance(raw, dict):
        return None, "not_an_object"
    ids = [sid for sid in raw.get("source_ids") or [] if isinstance(sid, str) and sid in by_id]
    if not ids:
        return None, "no_known_source"
    actor, task, work = (_text_or_none(raw.get(name)) for name in ("actor", "task", "work"))
    if not actor or not task or not work:
        return None, "missing_actor_task_or_work"
    for name, allowed in (("actor_role", ACTOR_ROLES), ("evidence_type", EVIDENCE_TYPES),
                          ("outcome", OUTCOMES), ("direction", DIRECTIONS)):
        if raw.get(name) not in allowed:
            return None, f"bad_{name}"
    posts = [by_id[sid] for sid in ids]
    texts = [(post["source_id"], post.get("text") or post.get("excerpt") or "") for post in posts]
    quote = _text_or_none(raw.get("quote"))
    quoted = quoted_in(quote, texts)
    if not quoted:
        return None, "quote_not_in_source"
    facts, refused_facts = _facts(raw.get("facts"), texts)
    try:
        occurred = _iso(raw.get("occurred_at")) if raw.get("occurred_at") else None
    except ValueError:
        occurred = None
    # The identity needs a day; when the post gives none, the day it was
    # published stands in, and the stored occurred_on stays null.
    stated = occurred is not None
    if occurred is None:
        occurred = min(post["published_at"] for post in posts)
    subject = _text_or_none(raw.get("subject"))
    observation = {
        "actor": actor, "actor_key": actor_key(actor, posts), "actor_role": raw["actor_role"],
        "subject": subject, "subject_key": _slug(subject) if subject else "unspecified",
        "work": work, "work_key": "unmapped", "task": task,
        "evidence_type": raw["evidence_type"], "outcome": raw["outcome"], "direction": raw["direction"],
        "facts": facts, "refused_facts": refused_facts,
        "scale": _text_or_none(raw.get("scale")), "conditions": _text_or_none(raw.get("conditions")),
        "occurred_on": occurred.date().isoformat(), "occurred_stated": stated,
        "sources": [{"source_id": post["source_id"], "url": post.get("url"),
                     "published_at": post["published_at"],
                     "quote": quote if post["source_id"] == quoted else None} for post in posts],
    }
    return observation, None


def assemble_observations(candidates, batches):
    """Checked observations of one run, merged by identity, and what was refused.

    Until the mapping pass gives a catalog entry, the identity takes the work as
    the model wrote it, so two different pieces of work by one actor on one day
    stay two observations. Merging keeps every source and every fact.
    """
    by_id = {c["source_id"]: c for c in candidates}
    merged, refused = {}, {}
    for batch in batches:
        for raw in batch.get("observations") or []:
            observation, reason = check_observation(raw, by_id)
            if reason:
                refused[reason] = refused.get(reason, 0) + 1
                continue
            draft_id = observation_id(observation["actor_key"], observation["subject_key"],
                                      "unmapped:" + (_slug(observation["work"]) or "work"),
                                      observation["occurred_on"])
            current = merged.get(draft_id)
            if current is None:
                merged[draft_id] = {"draft_id": draft_id, **observation}
                continue
            known = {s["source_id"] for s in current["sources"]}
            current["sources"] += [s for s in observation["sources"] if s["source_id"] not in known]
            current["facts"] += [f for f in observation["facts"] if f not in current["facts"]]
            current["refused_facts"] += observation["refused_facts"]
            current["occurred_stated"] = current["occurred_stated"] or observation["occurred_stated"]
    return list(merged.values()), refused
