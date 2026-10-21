"""Third-party verification of vendor claims from the evidence panel.

When a vendor's own claim is held down by its evidence tier (it said L3, a
vendor claim can carry L2), the only thing that can lift it is someone else
confirming it. This looks for that confirmation - but only where it could
change the result and the update matters (rule:verification-trigger), and only
among panel accounts that are enabled (rule:panel-lifecycle). A post counts at
the tier the rules give it (rule:verification-tier), never at a tier the judge
names.

The judge answers two choice questions per post, never a score: what kind of
post it is, and what level it shows. Scores are what put "L3.8" on the page.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from secrets import token_hex

from . import attention, panel, ontology_schema
from .post_events import mentions, subject_terms  # noqa: F401  (re-exported)
from .judge import JudgeError, TYPESAFE_URL, _post, build_judge
from .pipeline import digest
from .ontology_schema import EVENT_KIND_VOCABULARIES

METHOD_VERSION = "verification-2"  # asks whether the post is about the claimed product first
NOT_SHOWN = "not_shown"

NATURE_QUESTION = (
    "An AI company claimed something about its product (company_claim). Here is a post by "
    "someone else (post). First: is the post about THAT product? If it is about a different "
    "product or model, answer unrelated. Otherwise: what kind of post is it?"
)
LEVEL_QUESTION = (
    "On the work named below, how far does this post show the product going? "
    "Answer from what the post itself shows, not from the company's claim."
)


def _rule(name, model=None):
    return ontology_schema.rule(name, model)["expression"]


def tier_for(nature, independent, model=None):
    """rule:verification-tier: the post and its author's independence, nothing else."""
    if not independent:
        return None
    rule = _rule("rule:verification-tier", model)
    for tier in ("T1", "T2"):
        if nature in rule[tier]:
            return tier
    return None


def select_triggers(rows, model=None):
    """rule:verification-trigger over per-event rows; keeps input order."""
    rule = _rule("rule:verification-trigger", model)
    picked = []
    for row in rows:
        if rule["requires_capped_reading"] and not row["capped"]:
            continue
        if rule.get("requires_final_attention") and row.get("provisional"):
            continue
        important = (row.get("percentile") is not None and row["percentile"] >= rule["attention_percentile"]) \
            or row.get("kind") in rule["important_kinds"]
        if important:
            picked.append(row["event_id"])
    return picked


def in_window(created_utc, occurred_at, model=None):
    days = _rule("rule:verification-trigger", model)["lookup_days_after"]
    posted = datetime.fromtimestamp(created_utc, timezone.utc)
    return occurred_at <= posted <= occurred_at + timedelta(days=days)


def level_from_choice(choice):
    if not choice or choice == NOT_SHOWN:
        return None
    match = re.fullmatch(r"L([0-5])", str(choice))
    return int(match.group(1)) if match else None


TRIGGER_SQL = """
    SELECT ae.event_id, ae.activity_id, e.kind, e.subject_key, e.primary_org_id, e.occurred_at, e.title,
           floor(ae.observed_level)::int AS claimed,
           LEAST(floor(ae.observed_level), {cap})::int AS kept
      FROM public.activity_evidence ae
      JOIN public.extracted_events e ON e.event_id = ae.event_id
     WHERE e.kind_vocabulary = ANY(%s)
       AND ae.evidence_sign = 'positive' AND ae.status IN ('candidate', 'reviewed')
       AND ae.observed_level >= {min_score}
       AND floor(ae.observed_level) > LEAST(floor(ae.observed_level), {cap})
"""

PANEL_SQL = """
    SELECT a.account_key, a.handle, a.org_id AS owner_org_id,
           coalesce(json_agg(json_build_object('org_id', f.org_id, 'relation', f.relation,
                                               'started_on', f.started_on, 'ended_on', f.ended_on))
                    FILTER (WHERE f.affiliation_id IS NOT NULL), '[]') AS affiliations
      FROM public.source_accounts a
      LEFT JOIN public.person_affiliations f ON f.person_id = a.person_id
     WHERE a.panel_state = 'enabled' AND NOT a.excluded
     GROUP BY a.account_key, a.handle, a.org_id
     ORDER BY a.handle
"""


def triggers(conn, model=None):
    """Events worth verifying, each with its held-down readings."""
    sql = TRIGGER_SQL.format(cap=ontology_schema.level_cap_sql(), min_score=ontology_schema.min_level_score(model))
    readings = conn.execute(sql, (EVENT_KIND_VOCABULARIES,)).fetchall()
    noticed = attention.compute(conn.execute(attention.CAPTURES_SQL).fetchall(),
                                conn.execute(attention.LINKS_SQL, (EVENT_KIND_VOCABULARIES,)).fetchall())
    by_event = defaultdict(list)
    for r in readings:
        by_event[r["event_id"]].append(r)
    rows = [{"event_id": e, "kind": rs[0]["kind"], "capped": True,
             "percentile": (noticed.get(e) or {}).get("percentile"),
             "provisional": (noticed.get(e) or {}).get("provisional", True)} for e, rs in by_event.items()]
    rows.sort(key=lambda r: -(r["percentile"] or 0))
    return [(e, by_event[e]) for e in select_triggers(rows, model)]


def judge_post(judge, post, event, activities, timeout=120):
    """Two choice questions per post, one level question per held-down activity."""
    natures = {t: (ontology_schema.term("post_nature", t) or {}).get("definition", {}).get("en", t)
               for t in ontology_schema.term_ids("post_nature")}
    level_choices = {f"L{i}": label for i, label in enumerate(ontology_schema.level_scale())}
    level_choices[NOT_SHOWN] = "The post does not show how far the product goes on this work."
    questions = {"nature": {"type": "choice", "instructions": NATURE_QUESTION, "criteria": natures}}
    for i, act in enumerate(activities):
        questions[f"level_{i}"] = {"type": "choice",
                                   "instructions": {"question": LEVEL_QUESTION, "work": act["label"]},
                                   "criteria": level_choices}
    state = {"company_claim": event["title"], "post_author": "@" + post["author"],
             "relation_to_claim": LINK_WORDS.get(post.get("link"), "names the product"),
             "post": post["text"] or ""}
    body = _post(TYPESAFE_URL, {"state": state, "model": judge.model, "questions": questions},
                 judge.api_key, timeout)
    answers = body.get("answers") or {}
    nature = str((answers.get("nature") or {}).get("choice") or "unrelated")
    if nature not in natures:
        nature = "unrelated"
    levels = [level_from_choice((answers.get(f"level_{i}") or {}).get("choice")) for i in range(len(activities))]
    return nature, levels


EVENT_PANEL_POSTS_SQL = """
    SELECT DISTINCT ON (ep.source_id) ep.source_id, ep.link, cs.account_handle AS author, cs.published_at,
           coalesce(cc.full_text, cc.public_excerpt) AS text
      FROM public.event_posts ep
      JOIN public.collected_sources cs ON cs.source_id = ep.source_id
      LEFT JOIN public.collected_captures cc ON cc.source_id = ep.source_id
     WHERE ep.event_id = %s
       AND ep.link IN ('reply', 'quote', 'mention')
       AND lower(cs.account_handle) = ANY(%s)
       AND NOT EXISTS (SELECT 1 FROM public.verification_evidence ve
                        WHERE ve.event_id = ep.event_id AND ve.source_id = ep.source_id)
     ORDER BY ep.source_id, cc.captured_at DESC NULLS LAST
"""

LINK_WORDS = {"reply": "replies to the announcement thread", "quote": "quotes the announcement",
              "mention": "names the product without replying to it"}


def run(conn, ontology_version="1.0.0", limit_events=None, progress=print):
    """Judge and record third-party verification for triggered updates.

    No search: the panel's own timelines are collected by the project crawler
    and ingested like the official accounts (the X search endpoint returned 404
    while timelines stayed 200). Matching is local - a panel post in the week
    after the update that names the product.
    """
    picked = triggers(conn)
    if limit_events:
        picked = picked[:limit_events]
    accounts = conn.execute(PANEL_SQL).fetchall()
    if not picked or not accounts:
        return {"events": len(picked), "accounts": len(accounts), "posts": 0, "evidence": 0}
    judge = build_judge("typesafe")
    labels = {r["id"]: r["label_en"] for r in conn.execute(
        "SELECT id, label_en FROM public.ontology_concepts WHERE ontology_version = %s",
        (ontology_version,)).fetchall()}
    by_handle = {a["handle"].lower(): a for a in accounts}
    run_id = f"verify-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{token_hex(3)}"
    conn.execute(
        """INSERT INTO public.judgment_runs
             (run_id, judge, model, task, prompt_sha256, rubric_sha256, method_version,
              params, started_at, status, item_count, decided_count, run_sha256)
           VALUES (%s, 'typesafe', %s, 'verification', %s, %s, %s, %s::jsonb, %s, 'running', %s, 0, %s)""",
        (run_id, judge.model, digest({"nature": NATURE_QUESTION, "level": LEVEL_QUESTION}),
         digest(ontology_schema.rule("rule:verification-tier")), METHOD_VERSION,
         json.dumps({"events": [e for e, _ in picked]}), datetime.now(timezone.utc), len(picked),
         digest({"events": [e for e, _ in picked], "method_version": METHOD_VERSION})))
    totals = {"events": len(picked), "accounts": len(accounts), "posts": 0, "evidence": 0, "judge_errors": 0,
              "own_channel": 0}
    for event_id, readings in picked:
        head = readings[0]
        occurred = head["occurred_at"]
        # Posts come from the event's relation graph (post_events), not a search:
        # replies and quotes of its announcement, and mentions of its product.
        posts = conn.execute(EVENT_PANEL_POSTS_SQL, (event_id, list(by_handle))).fetchall()
        activities = [{"id": r["activity_id"], "label": labels.get(r["activity_id"], r["activity_id"])}
                      for r in readings]
        with conn.transaction():
            for post in posts:
                account = by_handle[post["author"].lower()]
                if account["owner_org_id"] is not None and account["owner_org_id"] == head["primary_org_id"]:
                    # The organisation's own account continuing its own announcement
                    # thread: that is the claim, not a reaction to it. Not judged.
                    totals["own_channel"] += 1
                    continue
                independent = panel.is_independent(account["affiliations"], head["primary_org_id"], occurred,
                                                   owner_org_id=account["owner_org_id"])
                try:
                    nature, levels = judge_post(judge, post, head, activities)
                except JudgeError as error:
                    progress(f"judge failed on {post['source_id']}: {error}")
                    totals["judge_errors"] += 1
                    continue
                tier = tier_for(nature, independent)
                for act, level in zip(activities, levels):
                    row = {"event_id": event_id, "activity_id": act["id"], "source_id": post["source_id"],
                           "account_key": account["account_key"], "ontology_version": ontology_version,
                           "post_nature": nature, "observed_level": level, "evidence_tier": tier,
                           "independent": independent, "status": "candidate",
                           "rationale": f"{nature} by @{post['author']}", "judgment_run_id": run_id}
                    conn.execute(
                        """INSERT INTO public.verification_evidence
                             (event_id, activity_id, source_id, account_key, ontology_version, post_nature,
                              observed_level, evidence_tier, independent, status, rationale, judgment_run_id,
                              record_sha256)
                           VALUES (%(event_id)s, %(activity_id)s, %(source_id)s, %(account_key)s,
                                   %(ontology_version)s, %(post_nature)s, %(observed_level)s, %(evidence_tier)s,
                                   %(independent)s, %(status)s, %(rationale)s, %(judgment_run_id)s, %(sha)s)
                           ON CONFLICT (event_id, activity_id, source_id) DO NOTHING""",
                        {**row, "sha": digest(row)})
                    if tier and level is not None:
                        totals["evidence"] += 1
                totals["posts"] += 1
        progress(f"{event_id}: {len(posts)} new panel posts linked to the event")
    conn.execute("UPDATE public.judgment_runs SET status = 'completed', finished_at = %s, decided_count = %s "
                 "WHERE run_id = %s", (datetime.now(timezone.utc), totals["posts"], run_id))
    return totals
