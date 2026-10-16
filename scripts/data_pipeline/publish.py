"""Export a validated, self-describing snapshot for the website to read.

The site never queries this database: it reads the files written here. So the
snapshot has to carry not only the findings but their provenance and their gaps -
a page that cannot say how much of the graph was actually judged will present a
0.2% positive rate as if it were a finished answer.

Nothing derived from a candidate edge is presented as settled. Candidate counts
and reviewed counts are always exported separately, so a page can show both and
is never forced to blur them.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from . import attention, checkpoint, ontology_schema
from .activity_state import ACTIVITY_LEVEL_SQL, IS_TASK, readings_sql
from .pipeline import digest
from .ontology_schema import EVENT_KIND_VOCABULARIES

ROOT = Path(__file__).resolve().parents[2]
PUBLISHED = ROOT / "datasets/published"
SNAPSHOT_VERSION = "snapshot-1"

# What produced the numbers: the four mapping passes, then the fold in
# activity_state. It used to be read from datasets/scoring/method.v1.json, a
# prior-only calibration config for the retired capability scorer - it named a
# method that had not run since before activities existed.
METHOD_VERSION = "activity-level-1"

# Per-capability and per-gate cap on the exported edge lists. A full sweep
# proposes on the order of a hundred thousand edges; shipping all of them would
# make the snapshot tens of megabytes and no page shows more than a screenful.
# The totals stay on each capability and gate row, so a page can always say how
# many exist rather than implying the listed ones are all of them.
#
# Both ends are taken, not just the top. Selecting purely by confidence would
# publish a file biased towards the firmest claims, and a page trying to show
# what most needs review would be showing the least certain of an already
# confident selection - the opposite of the review queue's own order.
EDGES_PER_SUBJECT = 200


def _rows(conn, sql, params=()):
    with conn.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall()


def _plain(value):
    """Database types the website cannot read: timestamps and numeric.

    Decimal becomes float deliberately - these are confidences and stages in a
    published snapshot, not money, and a stable JSON number is what the site needs.
    """
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def _clean(rows):
    return [{k: _plain(v) for k, v in row.items()} for row in rows]


LATEST_POSTS_PER_SOURCE = 3


def sources(conn) -> list[dict]:
    """The accounts being collected, with who owns each and what it last wrote.

    Only enabled, non-excluded accounts: a candidate has not had its identity
    confirmed, and publishing it beside the others would say we follow it.
    `latest` holds the account's own posts - replies and reposts are left out,
    because a repost is someone else's words under this account's name. The text
    is the stored public excerpt in its original language, never a translation.
    `posts` and `latest_post_at` are null for an account nothing was collected
    from, which is not the same as an account that wrote nothing.
    """
    accounts = _clean(_rows(conn, """
        SELECT a.account_key, a.handle, a.platform, a.owner_kind, a.panel_role, a.identity_grade,
               a.identity_url, a.language, a.focus, a.avatar_url, a.platform_account_id,
               a.person_id, a.org_id,
               COALESCE(p.name, o.canonical_name_en, a.org_name) AS name,
               CASE WHEN a.owner_kind = 'organization' THEN o.canonical_name_zh_cn END AS name_zh_cn
          FROM public.source_accounts a
          LEFT JOIN public.people p ON p.person_id = a.person_id
          LEFT JOIN public.org_registry o ON o.org_id = a.org_id
         WHERE a.panel_state = 'enabled' AND NOT a.excluded
         ORDER BY a.account_key"""))
    affiliations = {}
    for r in _rows(conn, """
            SELECT f.person_id, f.org_id, COALESCE(o.canonical_name_en, f.org_name) AS org_name,
                   f.relation, f.role_title
              FROM public.person_affiliations f
              LEFT JOIN public.org_registry o ON o.org_id = f.org_id
             WHERE f.relation <> 'former' AND f.ended_on IS NULL
             ORDER BY f.person_id, f.started_on DESC NULLS LAST, f.affiliation_id"""):
        affiliations.setdefault(r["person_id"], []).append(
            {k: r[k] for k in ("org_id", "org_name", "relation", "role_title")})
    totals = {r["account_external_id"]: r for r in _clean(_rows(conn, """
        SELECT account_external_id, count(*) AS posts, max(published_at) AS latest_post_at
          FROM public.collected_sources GROUP BY account_external_id"""))}
    latest = {}
    for r in _clean(_rows(conn, """
            SELECT * FROM (
              SELECT s.account_external_id, s.source_id, s.canonical_url, s.published_at,
                     c.public_excerpt AS excerpt, c.language, c.metrics, c.captured_at,
                     row_number() OVER (PARTITION BY s.account_external_id
                                        ORDER BY s.published_at DESC, s.source_id) AS n
                FROM public.collected_sources s
                JOIN LATERAL (SELECT public_excerpt, language, metrics, captured_at
                                FROM public.collected_captures c
                               WHERE c.source_id = s.source_id
                               ORDER BY c.captured_at DESC LIMIT 1) c ON TRUE
               WHERE NOT s.is_reply AND NOT s.is_repost AND c.public_excerpt IS NOT NULL
                 -- A company's own account is shown as it posts. Anyone else's
                 -- post is shown only when the extractor read it and it states an
                 -- update or says something about one (rule:post-outcome): most of
                 -- what people post is not about AI at all.
                 AND (EXISTS (SELECT 1 FROM public.source_accounts a
                               WHERE a.platform_account_id = s.account_external_id
                                 AND a.panel_role = 'official')
                      OR EXISTS (SELECT 1 FROM public.extracted_event_sources es
                                  WHERE es.source_id = s.source_id)
                      OR EXISTS (SELECT 1 FROM public.extracted_event_attachments ea
                                  WHERE ea.source_id = s.source_id))
            ) ranked WHERE n <= %s ORDER BY account_external_id, n""", (LATEST_POSTS_PER_SOURCE,))):
        latest.setdefault(r.pop("account_external_id"), []).append(
            {"source_id": r["source_id"], "url": r["canonical_url"], "published_at": r["published_at"],
             "excerpt": r["excerpt"], "language": r["language"],
             "likes": (r["metrics"] or {}).get("likes"), "views": (r["metrics"] or {}).get("views"),
             "metrics_at": r["captured_at"]})
    # Followers as the platform reported them at the account's last lookup: an
    # observed audience size with its own date, not a measure of being right.
    followers = {r["account_key"]: r for r in _clean(_rows(conn, """
        SELECT DISTINCT ON (account_key) account_key,
               (detail->>'followers')::bigint AS followers, checked_at
          FROM public.source_account_checks
         WHERE check_kind = 'profile' AND outcome = 'pass' AND detail->>'followers' IS NOT NULL
         ORDER BY account_key, checked_at DESC"""))}
    for account in accounts:
        seen = followers.get(account["account_key"])
        account["followers"] = seen["followers"] if seen else None
        account["followers_at"] = seen["checked_at"] if seen else None
        external = account.pop("platform_account_id")
        total = totals.get(external)
        account["affiliations"] = affiliations.get(account["person_id"], []) if account["person_id"] else []
        account["posts"] = total["posts"] if total else None
        account["latest_post_at"] = total["latest_post_at"] if total else None
        account["latest"] = latest.get(external, [])
    return accounts


def topics(conn) -> list[dict]:
    """The open questions, each with its answers, who argued them and what weighs on them.

    A topic carries no answer (rule:topic-carries-no-answer): what is published
    is who argued each answer in the posts collected, and which updates a judge
    found to weigh for or against it. The counts say nothing about how many
    people think so. A topic that failed the standard it was written to, or
    was merged or closed, is not published.

    An account the panel has not confirmed is published with its claim and
    marked as such: we know only that this account said so.
    """
    from . import topic_mining

    found = [topic_mining.describe(t) for t in topic_mining.load_topics(conn, lambda sql: _rows(conn, sql))]
    found = [t for t in found if t["status"] != "fails"]
    in_panel = {r["handle"].lower(): r["account_key"] for r in _rows(conn, """
        SELECT handle, account_key FROM public.source_accounts
         WHERE panel_state = 'enabled' AND NOT excluded""")}
    entries = {r["id"]: r for r in _rows(conn, """
        SELECT id, kind, label_en, label_zh_cn FROM public.ontology_concepts
         WHERE ontology_version = (SELECT max(ontology_version) FROM public.ontology_concepts)
           AND kind IN ('occupation', 'occupation_group', 'market', 'market_group')""")}
    kinds = {key: row["kind"] for key, row in entries.items()}
    # The group an occupation or a market sits in: what a reader browses topics by.
    parents = {r["child_id"]: r["parent_id"] for r in _rows(conn, """
        SELECT child_id, parent_id FROM public.ontology_relations
         WHERE kind IN ('has_occupation', 'has_market')
           AND ontology_version = (SELECT max(ontology_version) FROM public.ontology_relations)""")}

    def group_of(anchor):
        found = anchor if kinds.get(anchor) in ("occupation_group", "market_group") else parents.get(anchor)
        row = entries.get(found)
        return row and {"id": found, "en": row["label_en"], "zh-CN": row["label_zh_cn"] or row["label_en"]}
    weighing: dict[str, list] = {}
    for r in _clean(_rows(conn, """
            SELECT w.topic_id, o.position, w.sign, w.confidence, e.event_id, e.title, e.kind,
                   COALESCE(e.occurred_at, e.announced_at) AS occurred_at,
                   COALESCE(org.canonical_name_en, a.handle) AS by_name,
                   (SELECT min(cs.canonical_url) FROM public.extracted_event_sources es
                      JOIN public.collected_sources cs ON cs.source_id = es.source_id
                     WHERE es.event_id = e.event_id AND cs.canonical_url IS NOT NULL) AS source_url
              FROM public.topic_option_evidence w
              JOIN public.topic_options o ON o.option_id = w.option_id
              JOIN public.extracted_events e ON e.event_id = w.event_id
              LEFT JOIN public.org_registry org ON org.org_id = e.primary_org_id
              LEFT JOIN public.source_accounts a ON a.account_key = e.actor_account_key
             WHERE w.status <> 'rejected' AND NOT o.retired
             ORDER BY w.topic_id, o.position, w.confidence DESC, e.event_id""")):
        weighing.setdefault(r.pop("topic_id"), []).append(
            {"event_id": r["event_id"], "option": "abcdefgh"[r["position"] - 1], "sign": r["sign"],
             "confidence": r["confidence"], "title": r["title"], "kind": r["kind"],
             "occurred_at": r["occurred_at"], "by": r["by_name"], "source_url": r["source_url"]})
    out = []
    for topic in found:
        evidence = weighing.get(topic["id"], [])
        claims = [{"source_id": c["id"], "option": c["option"], "handle": c["handle"],
                   "account_key": in_panel.get(str(c["handle"]).lower()),
                   "url": c["url"], "published_at": c["published_at"], "says": c["claim"],
                   "quote": c["quote"], "views": c["views"] or None}
                  for c in sorted(topic["claims"], key=lambda c: (c["published_at"], c["id"]))]
        options = []
        for position, option in enumerate(topic["options"], 1):
            mine = [c for c in claims if c["option"] == option["key"]]
            options.append({
                "option_id": topic_mining.option_id(topic["id"], option["key"]), "key": option["key"],
                "position": position, "text": {"en": option["en"], "zh-CN": option["zh-CN"]},
                "accounts": len({c["handle"] for c in mine}),
                "panel_accounts": len({c["handle"] for c in mine if c["account_key"]}),
                "supports": sum(1 for e in evidence if e["option"] == option["key"] and e["sign"] == "supports"),
                "contradicts": sum(1 for e in evidence if e["option"] == option["key"] and e["sign"] == "contradicts"),
            })
        anchor = topic["anchor"]
        out.append({
            "topic_id": topic["id"],
            # The id without its prefix, for an address: topic:replacement:accountant:0f5f53ad.
            "slug": topic["id"].split(":", 1)[1].replace(":", "-"),
            "question_type": topic["question_type"], "object": topic["object"],
            "question": topic["question"], "state": topic["state"], "origin": topic["origin"],
            # Two or more answers each have someone arguing them, or only one does.
            "sides": "open" if topic["status"] == "open" else "one_sided",
            "about": anchor and {"id": anchor, "kind": kinds.get(anchor), **topic["anchor_name"]},
            # Null when the catalog has no entry for what the topic is about.
            "group": group_of(anchor) if anchor else None,
            "opened_at": topic["opened_at"],
            "latest_claim_at": max((c["published_at"] for c in claims), default=None),
            "accounts": topic["accounts"], "posts": topic["posts"],
            "options": options, "claims": claims, "evidence": evidence,
            "by_quarter": topic["by_quarter"],
        })
    out.sort(key=lambda t: t["topic_id"])
    return out


# X ids carry their own time: milliseconds since this epoch, shifted left 22 bits.
X_EPOCH_MS = 1288834974657


def confirmation(row: dict) -> dict:
    """One post that confirmed a vendor's reading, as a page can cite it."""
    handle, source_id = row.get("handle"), str(row["source_id"])
    posted = (datetime.fromtimestamp(((int(source_id) >> 22) + X_EPOCH_MS) / 1000, timezone.utc).isoformat()
              if source_id.isdigit() else None)
    return {
        "source_id": source_id,
        "account_key": row["account_key"],
        "handle": handle,
        "url": f"https://x.com/{handle}/status/{source_id}" if handle and source_id.isdigit() else None,
        "posted_at": posted,
        "post_nature": row["post_nature"],
        "evidence_tier": row["evidence_tier"],
        "observed_level": row["observed_level"],
        "level": row["level"],
    }


def build(conn, ontology_version: str | None = None) -> dict:
    if ontology_version is None:
        found = _rows(conn, "SELECT version FROM public.ontology_releases ORDER BY version DESC LIMIT 1")
        if not found:
            raise ValueError("No ontology release imported")
        ontology_version = found[0]["version"]

    # --- the activity layer ----------------------------------------------------
    #
    # An activity is what a market actually does, and it is the only thing the
    # judge scores. Capabilities used to sit here: forty-one of the forty-six
    # matched every kind of work, so the layer answered every question with the
    # same answer and told a reader nothing about which work an update touches.
    #
    # Both an activity and a task are kind='work'; the ontology separates them by
    # relation, so that is what this reads.
    activities = _clean(_rows(conn, f"""
        WITH level AS ({ACTIVITY_LEVEL_SQL})
        SELECT a.id AS activity_id, a.label_en, a.label_zh_cn,
               m.id AS market_id, m.label_en AS market_en, m.label_zh_cn AS market_zh_cn,
               l.level, l.best_tier, l.evidence_rows, coalesce(l.gated, false) AS gated,
               (SELECT count(*) FROM public.activity_task_edges t
                 WHERE t.activity_id = a.id AND t.status IN ('candidate', 'reviewed')) AS tasks,
               (SELECT count(*) FROM public.activity_gate_edges g
                 WHERE g.activity_id = a.id AND g.status IN ('candidate', 'reviewed')) AS gates
          FROM public.ontology_concepts a
          JOIN public.ontology_relations r
            ON r.ontology_version = a.ontology_version AND r.child_id = a.id
           AND r.kind = 'has_work'
          JOIN public.ontology_concepts m
            ON m.ontology_version = a.ontology_version AND m.id = r.parent_id
          LEFT JOIN level l ON l.activity_id = a.id
         WHERE a.ontology_version = %s AND a.kind = 'work'
         ORDER BY m.id, a.id""", (ontology_version,)))

    # Which occupations each market is served by. One market, many occupations;
    # an occupation can serve several markets.
    markets = _clean(_rows(conn, """
        SELECT e.market_id, e.occupation_id, e.confidence, e.status,
               o.label_en AS occupation_en, o.label_zh_cn AS occupation_zh_cn
          FROM public.market_occupation_edges e
          JOIN public.ontology_concepts o
            ON o.ontology_version = e.ontology_version AND o.id = e.occupation_id
         WHERE e.ontology_version = %s AND e.status IN ('candidate', 'reviewed')
         ORDER BY e.market_id, e.confidence DESC NULLS LAST""", (ontology_version,)))

    # Which tasks each activity covers. This is the edge the grid is drawn from.
    tasks = _clean(_rows(conn, """
        SELECT t.activity_id, t.task_id, t.confidence, t.status
          FROM public.activity_task_edges t
         WHERE t.ontology_version = %s AND t.status IN ('candidate', 'reviewed')
         ORDER BY t.activity_id, t.confidence DESC NULLS LAST""", (ontology_version,)))

    # Every reading an update produced, with the update it came from.
    #
    # This used to select capability_evidence filtered by the newest completed
    # run with task='demonstrates' - and the event routing pass registers itself
    # under that same task name, so the filter matched nothing and the file
    # published as an empty list while 710 rows sat in the database.
    evidence = _clean(_rows(conn, """
        SELECT ae.activity_id, ae.event_id, ae.evidence_tier, ae.evidence_sign,
               ae.observed_level, ae.confidence, ae.rationale, ae.status,
               a.label_en AS activity_en, a.label_zh_cn AS activity_zh_cn,
               e.title, e.summary, e.kind, e.kind_vocabulary, e.occurred_at,
               coalesce(o.canonical_name_en, e.primary_org) AS org_name,
               e.primary_org_id
          FROM public.activity_evidence ae
          JOIN public.extracted_events e ON e.event_id = ae.event_id
          JOIN public.ontology_concepts a
            ON a.ontology_version = ae.ontology_version AND a.id = ae.activity_id
          LEFT JOIN public.org_registry o ON o.org_id = e.primary_org_id
         WHERE ae.ontology_version = %s AND ae.status IN ('candidate', 'reviewed')
         ORDER BY e.occurred_at DESC NULLS LAST, ae.activity_id""", (ontology_version,)))

    # What posts by others said about a vendor's claim (the evidence panel). These
    # readings count toward an activity's level - a third party's hands-on test can
    # carry what the vendor's own T3 claim could not - and until 2026-10-16 none of
    # them was published, so a work page could stand at L3 with only L2 readings
    # listed under it. The filter and the cap are those of `readings_sql`, so what
    # is published here is exactly what was counted.
    confirmations = _clean(_rows(conn, f"""
        SELECT ve.event_id, ve.activity_id, ve.source_id, ve.account_key, sa.handle,
               ve.post_nature, ve.evidence_tier, ve.observed_level,
               LEAST(ve.observed_level, {ontology_schema.level_cap_sql("ve.evidence_tier")},
                     {ontology_schema.nature_cap_sql("ve.post_nature")}) AS level
          FROM public.verification_evidence ve
          LEFT JOIN public.source_accounts sa ON sa.account_key = ve.account_key
         WHERE ve.ontology_version = %s AND ve.status IN ('candidate', 'reviewed')
           AND ve.evidence_tier IS NOT NULL AND ve.observed_level IS NOT NULL
         ORDER BY ve.event_id, ve.activity_id, ve.source_id""", (ontology_version,)))

    gates = _clean(_rows(conn, """
        SELECT g.gate_id, g.gate_type, g.label_en, g.label_zh_cn,
               g.definition_en, g.definition_zh_cn,
               st.status, st.rationale AS state_rationale, st.as_of AS state_as_of,
               st.source_event_id,
               (SELECT count(*) FROM public.activity_gate_edges e
                 WHERE e.gate_id = g.gate_id AND e.status = 'candidate') AS candidate_activities,
               (SELECT count(*) FROM public.activity_gate_edges e
                 WHERE e.gate_id = g.gate_id AND e.status = 'reviewed') AS reviewed_activities
        FROM public.gates g
        LEFT JOIN LATERAL (
            SELECT * FROM public.gate_states s
            WHERE s.gate_id = g.gate_id ORDER BY s.as_of DESC LIMIT 1) st ON TRUE
        WHERE g.lifecycle = 'active' ORDER BY g.gate_id"""))

    events = _clean(_rows(conn, """
        SELECT e.event_id, e.title, e.summary, e.kind, e.kind_vocabulary,
               e.unresolved_reason, e.subject_key, e.identity_confidence,
               e.occurred_at, e.confidence, e.primary_org_id,
               coalesce(o.canonical_name_en, e.primary_org) AS org_name,
               o.canonical_name_zh_cn AS org_name_zh_cn,
               e.subject, e.basis, e.task, e.result, e.quote, e.schema_version,
               (SELECT json_agg(json_build_object('value', f.value, 'unit', f.unit, 'what', f.what,
                                                  'quote', f.quote) ORDER BY f.fact_id)
                  FROM public.extracted_event_facts f WHERE f.event_id = e.event_id) AS facts,
               (SELECT count(*) FROM public.extracted_event_sources s
                 WHERE s.event_id = e.event_id) AS source_count,
               (SELECT json_agg(cs.canonical_url ORDER BY cs.canonical_url)
                  FROM public.extracted_event_sources s
                  JOIN public.collected_sources cs ON cs.source_id = s.source_id
                 WHERE s.event_id = e.event_id
                   AND cs.canonical_url IS NOT NULL) AS source_urls
        FROM public.extracted_events e
        LEFT JOIN public.org_registry o ON o.org_id = e.primary_org_id
        WHERE e.kind_vocabulary = ANY(%s) AND e.primary_org_id IS NOT NULL
        ORDER BY e.occurred_at DESC NULLS LAST, e.event_id
        LIMIT 2000""", (EVENT_KIND_VOCABULARIES,)))

    # How much notice each update drew (rule:attention-baseline): its loudest
    # source post, read at a comparable age and against its own account's
    # median. Nothing below reads this into a level - engagement is not
    # evidence - it ranks what deserves a reader's attention and which updates
    # are worth checking with third parties. Missing stays null, never zero.
    noticed = attention.compute(_rows(conn, attention.CAPTURES_SQL),
                                _rows(conn, attention.LINKS_SQL, (EVENT_KIND_VOCABULARIES,)))
    series = attention.series_sizes(events)
    for event in events:
        event["attention"] = noticed.get(event["event_id"])
        event["series_size"] = series.get(event.get("subject_key"))

    # The legacy generation is the same collection window read with the older
    # free-form vocabulary: 730 of its 787 source posts are re-covered by the
    # current extraction. Publishing both put one window on the page twice, which
    # is why this is a filter and not a LIMIT. The superseded rows stay in the
    # database and are counted here, because a number that quietly halved needs
    # to say where the other half went.
    generations = _clean(_rows(conn, """
        SELECT e.kind_vocabulary AS vocabulary,
               -- count(*) here would count join rows: an event with four source
               -- posts would be four events.
               count(DISTINCT e.event_id) AS events,
               count(DISTINCT s.source_id) AS source_posts
        FROM public.extracted_events e
        LEFT JOIN public.extracted_event_sources s ON s.event_id = e.event_id
        GROUP BY 1 ORDER BY 2 DESC"""))
    shared_posts = _rows(conn, """
        SELECT count(*) AS n FROM (
            SELECT s.source_id FROM public.extracted_events e
              JOIN public.extracted_event_sources s ON s.event_id = e.event_id
             WHERE e.kind_vocabulary <> ALL(%s)
            INTERSECT
            SELECT s.source_id FROM public.extracted_events e
              JOIN public.extracted_event_sources s ON s.event_id = e.event_id
             WHERE e.kind_vocabulary = ANY(%s)) x""",
        (EVENT_KIND_VOCABULARIES, EVENT_KIND_VOCABULARIES))[0]["n"]
    for row in generations:
        row["published"] = row["vocabulary"] in EVENT_KIND_VOCABULARIES
        row["source_posts_also_in_current"] = None if row["published"] else shared_posts

    # Coverage is part of the finding, not a footnote. A page that shows edges
    # without showing how much of the graph was never judged is misleading.
    work_total = _rows(conn, f"""
        SELECT count(*) AS n FROM public.ontology_concepts w
        WHERE w.ontology_version = %s AND w.kind = 'work'
          AND {IS_TASK}""", (ontology_version,))[0]["n"]
    event_kinds = _clean(_rows(conn, """
        SELECT kind_vocabulary, coalesce(kind, '(unresolved)') AS kind, count(*) AS n
        FROM public.extracted_events GROUP BY 1, 2 ORDER BY 1, 3 DESC"""))
    runs = _clean(_rows(conn, """
        SELECT run_id, judge, model, task, method_version, status,
               item_count, decided_count, started_at, finished_at
        FROM public.judgment_runs ORDER BY started_at DESC LIMIT 50"""))

    # Only completed runs count toward coverage, but a page that says
    # "19,397 unjudged" while a sweep is halfway through is reporting a number
    # that is true and misleading at once. Say that a run is in flight.
    in_progress = _clean(_rows(conn, """
        SELECT run_id, judge, task, item_count, started_at
        FROM public.judgment_runs WHERE status = 'running' ORDER BY started_at"""))

    # What is waiting for a person. A site that shows thousands of candidate
    # edges without showing that every one of them is still waiting has told
    # only the flattering half.
    # Split by edge kind as well as judge and task: the seed run proposed both
    # requires and blocked_by edges under task 'requires', so grouping without
    # the edge kind produced two indistinguishable rows for the same pair.
    # The judges' confidence numbers are not the same measurement. One is a
    # transformed probability, the other is a model reporting its own certainty,
    # and the second is systematically higher. Publishing the shape of each
    # distribution lets a page say what a given number means for a given judge
    # instead of treating 0.8 as 0.8.
    # How much of the proposed graph actually reaches a conclusion. An edge to a
    # capability with no evidence names work that might be affected by something
    # nobody has measured; an edge to a capability that reaches most of the work
    # names work without distinguishing it. Neither is a finding, and a page that
    # reports edge counts without this reports the flattering half.
    #
    # The threshold is passed in from the schema rather than written into
    # this SQL: a literal here would be a second copy of the rule.
    # Two judges over the same pairs. The full sweep is one judge's work, so the
    # --- what was looked at, and what was not ----------------------------------
    #
    # Reach, not confidence. Every number here is about the collection: how many
    # updates were read, how many bore on anything, how much of the world any of
    # it touched. None of it is evidence that AI cannot do the untouched work.
    routed = _rows(conn, """
        SELECT count(*) AS events,
               count(*) FILTER (WHERE kept > 0) AS events_with_activity,
               sum(kept) AS readings
          FROM public.judgment_checkpoints
         WHERE method_version = %s""", (checkpoint.EVENT_ROUTING,))[0]

    window = _rows(conn, """
        SELECT min(occurred_at) AS first, max(occurred_at) AS last, count(*) AS events
          FROM public.extracted_events WHERE occurred_at IS NOT NULL""")[0]

    by_org = _clean(_rows(conn, """
        SELECT coalesce(o.canonical_name_en, e.primary_org, 'unattributed') AS org,
               count(*) AS events
          FROM public.extracted_events e
          LEFT JOIN public.org_registry o ON o.org_id = e.primary_org_id
         GROUP BY 1 ORDER BY 2 DESC"""))

    tasks_by_activity: dict[str, int] = {}
    for edge in tasks:
        tasks_by_activity[edge["activity_id"]] = tasks_by_activity.get(edge["activity_id"], 0) + 1

    coverage = {
        "work_items_total": work_total,
        "activities_total": len(activities),
        "activities_with_evidence": sum(1 for a in activities if a["evidence_rows"]),
        "activities_with_tasks": sum(1 for a in activities if a["tasks"]),
        "activities_behind_a_gate": sum(1 for a in activities if a["gated"]),
        # Work that was judged and then counted for nothing.
        #
        # Every progress number on the site is counted in TASKS, and a task
        # reaches the count through an activity-to-task edge. 52 activities have
        # no such edge, so a reading on one of them contributes to no
        # percentage anywhere - including the headline "6 of 100 squares". The
        # markets they belong to disappear from every task-based view: 265
        # markets have activities, 251 have a task. That gap is a mapping gap,
        # not a finding about the work, and it is published so it can be closed
        # rather than rediscovered.
        "markets_total": len({a["market_id"] for a in activities}),
        "markets_with_tasks": len({a["market_id"] for a in activities if a["tasks"]}),
        "activities_without_tasks": sum(1 for a in activities if not a["tasks"]),
        "readings_on_activities_without_tasks": sum(
            1 for row in evidence
            if row["evidence_sign"] == "positive"
            and not tasks_by_activity.get(row["activity_id"])
        ),
        # 325 of 581 routed updates bore on no activity at all. That is the most
        # honest single number on the site and it is published, not hidden.
        "events_routed": routed["events"],
        "events_bearing_on_activity": routed["events_with_activity"],
        "readings_taken": routed["readings"] or 0,
        "collection_window": {"first": _plain(window["first"]),
                              "last": _plain(window["last"]),
                              "events": window["events"]},
        # Three weeks, and two publishers account for most of it. A reader has to
        # be able to see the skew before reading anything else on the page.
        "events_by_organisation": by_org,
        "event_kinds": event_kinds,
        "event_generations": generations,
        "judgment_runs": runs,
        "runs_in_progress": in_progress,
    }

    # --- takeover progress -----------------------------------------------------
    #
    # One work item, one square, filled to the LOWEST level among the activities
    # that cover it. A task needs all of its work done, so AI failing at any part
    # means the task is not done. Taking the highest is what put baggage porters
    # at 59%: greeting guests matched a communication activity and carrying the
    # bags was ignored.
    #
    # Three states, kept apart. A task no activity covers is untouched. A task
    # covered by an activity that has no evidence is unknown, because the minimum
    # of an unknown is unknown. Neither is zero, and folding them into one empty
    # bucket is exactly how "nobody has looked" comes to read as "AI cannot".
    #
    # What the level may reach is capped by the kind of evidence behind it
    # (T1 5 / T2 4 / T3 2 / T4 1), and a gate caps the activity at L3
    # (rule:gate-caps-level) - it rules out delivery without a person, not AI taking part:
    # a condition that does not lift when models improve is not a capability
    # question and does not yield to one.
    #
    # Capabilities no longer appear here. Forty-one of the forty-six were work
    # traits that matched everything, so the layer answered every question with
    # the same answer; the 614 market activities carry the evidence instead.
    progress_sql = f"""
        WITH capped AS ({readings_sql(versioned=True)}),
        best AS (SELECT activity_id, max(level) AS level FROM capped GROUP BY 1),
        activity AS (
          SELECT b.activity_id,
                 CASE WHEN g.activity_id IS NOT NULL THEN LEAST(b.level, {ontology_schema.gate_level_cap()}) ELSE b.level END AS level
            FROM best b
            LEFT JOIN LATERAL (
              SELECT ge.activity_id FROM public.activity_gate_edges ge
               WHERE ge.activity_id = b.activity_id
                 AND ge.status IN ('candidate', 'reviewed') LIMIT 1) g ON TRUE),
        covered AS (
          SELECT ate.task_id, a.level
            FROM public.activity_task_edges ate
            LEFT JOIN activity a ON a.activity_id = ate.activity_id
           WHERE ate.status IN ('candidate', 'reviewed')
             AND ate.ontology_version = %s),
        task_level AS (
          SELECT task_id,
                 CASE WHEN bool_or(level IS NULL) THEN NULL ELSE min(level) END AS level
            FROM covered GROUP BY 1),
        per_task AS (
          SELECT w.id AS work_id, tl.level AS top_stage,
                 CASE WHEN tl.task_id IS NULL THEN 'untouched'
                      WHEN tl.level IS NULL THEN 'unknown'
                      ELSE 'assessed' END AS coverage
            FROM public.ontology_concepts w
            LEFT JOIN task_level tl ON tl.task_id = w.id
           WHERE w.kind = 'work' AND w.ontology_version = %s
             AND {IS_TASK})
    """
    # One version per %s: the vendor and verification branches of capped, then
    # the task and grid filters below it.
    progress_params = (ontology_version, ontology_version, ontology_version, ontology_version)
    global_buckets = _clean(_rows(conn, progress_sql + """
        SELECT floor(top_stage)::int AS stage, coverage, count(*) AS work_items
        FROM per_task GROUP BY 1, 2 ORDER BY 1 NULLS FIRST""", progress_params))
    occupation_buckets = _rows(conn, progress_sql + """,
        occupation_task AS (
          SELECT parent_id AS occupation_id, child_id AS work_id
          FROM public.ontology_relations
          WHERE kind = 'has_task' AND ontology_version = %s)
        SELECT ot.occupation_id, floor(pt.top_stage)::int AS stage, pt.coverage,
               count(DISTINCT ot.work_id) AS work_items
        FROM occupation_task ot
        JOIN per_task pt ON pt.work_id = ot.work_id
        GROUP BY 1, 2, 3""", progress_params + (ontology_version,))

    # The same shape one level up. Comparison needs a small number of rows the
    # eye can hold at once: 22 groups fit on a screen, 923 occupations do not.
    group_buckets = _rows(conn, progress_sql + """,
        group_task AS (
          SELECT g.parent_id AS group_id, t.child_id AS work_id
          FROM public.ontology_relations g
          JOIN public.ontology_relations t
            ON t.parent_id = g.child_id AND t.kind = 'has_task'
           AND t.ontology_version = g.ontology_version
          WHERE g.kind = 'has_occupation' AND g.ontology_version = %s)
        SELECT gt.group_id, floor(pt.top_stage)::int AS stage, pt.coverage,
               count(DISTINCT gt.work_id) AS work_items
        FROM group_task gt
        JOIN per_task pt ON pt.work_id = gt.work_id
        GROUP BY 1, 2, 3""", progress_params + (ontology_version,))

    # A market's own square set: the tasks its activities translate to. Markets
    # are kinds of work rather than industries, which is why an update lands on
    # one at all, and why a market can carry a share the reader can check.
    market_buckets = _rows(conn, progress_sql + """,
        market_task AS (
          SELECT DISTINCT r.parent_id AS market_id, ate.task_id AS work_id
          FROM public.ontology_relations r
          JOIN public.activity_task_edges ate
            ON ate.activity_id = r.child_id AND ate.ontology_version = r.ontology_version
           AND ate.status IN ('candidate', 'reviewed')
          WHERE r.kind = 'has_work' AND r.ontology_version = %s)
        SELECT mt.market_id, floor(pt.top_stage)::int AS stage, pt.coverage,
               count(DISTINCT mt.work_id) AS work_items
        FROM market_task mt
        JOIN per_task pt ON pt.work_id = mt.work_id
        GROUP BY 1, 2, 3""", progress_params + (ontology_version,))

    group_labels = {
        row["id"]: row for row in _rows(conn, """
            SELECT id, label_en, label_zh_cn FROM public.ontology_concepts
            WHERE kind = 'occupation_group' AND ontology_version = %s""", (ontology_version,))
    }

    by_group: dict[str, dict] = {
        group_id: {
            "label_en": label.get("label_en"),
            "label_zh_cn": label.get("label_zh_cn"),
            "tasks": 0, "by_stage": {},
        }
        for group_id, label in group_labels.items()
    }
    for row in group_buckets:
        entry = by_group[row["group_id"]]
        # "unknown" and "untouched" are different findings and get different
        # keys; the old single "none" bucket made them indistinguishable.
        key = row["coverage"] if row["stage"] is None else str(row["stage"])
        entry["by_stage"][key] = row["work_items"]
        entry["tasks"] += row["work_items"]

    occupation_group = {
        row["child_id"]: row["parent_id"] for row in _rows(conn, """
            SELECT parent_id, child_id FROM public.ontology_relations
            WHERE kind = 'has_occupation' AND ontology_version = %s""", (ontology_version,))
    }

    # Labels are ontology data and belong on the row that names the concept.
    # They used to be read off the capability impact rows, which meant an
    # occupation no capability reached had no name anywhere on the site.
    occupation_labels = {
        row["id"]: row for row in _rows(conn, """
            SELECT id, label_en, label_zh_cn FROM public.ontology_concepts
            WHERE kind = 'occupation' AND ontology_version = %s""", (ontology_version,))
    }
    by_occupation: dict[str, dict] = {}
    for row in occupation_buckets:
        label = occupation_labels.get(row["occupation_id"], {})
        entry = by_occupation.setdefault(row["occupation_id"], {
            "group_id": occupation_group.get(row["occupation_id"]),
            "label_en": label.get("label_en"),
            "label_zh_cn": label.get("label_zh_cn"),
            "tasks": 0, "by_stage": {},
        })
        key = row["coverage"] if row["stage"] is None else str(row["stage"])
        entry["by_stage"][key] = row["work_items"]
        entry["tasks"] += row["work_items"]

    market_labels = {
        row["id"]: row for row in _rows(conn, """
            SELECT id, label_en, label_zh_cn FROM public.ontology_concepts
            WHERE kind = 'market' AND ontology_version = %s""", (ontology_version,))
    }
    by_market: dict[str, dict] = {}
    for row in market_buckets:
        label = market_labels.get(row["market_id"], {})
        entry = by_market.setdefault(row["market_id"], {
            "label_en": label.get("label_en"),
            "label_zh_cn": label.get("label_zh_cn"),
            "tasks": 0, "by_stage": {},
        })
        key = row["coverage"] if row["stage"] is None else str(row["stage"])
        entry["by_stage"][key] = row["work_items"]
        entry["tasks"] += row["work_items"]

    progress = {
        "method_version": METHOD_VERSION,
        # L0-L5, and L5 is published even while empty: "no work anywhere runs
        # with nobody" is the most important line on the chart, and a bucket
        # with no rows would simply not be drawn. The ladder, its wording and its
        # caps all come from the activity_level vocabulary, so the site draws the
        # same scale the judge was asked and never carries its own copy.
        "stages": ontology_schema.level_ids(),
        "levels": ontology_schema.level_labels(),
        "level_definitions": ontology_schema.level_definitions(),
        "states": ["assessed", "unknown", "untouched"],
        # What each kind of evidence is allowed to support. Published so a reader
        # can see why nothing sits above L2 while the evidence is vendor claims.
        "tier_caps": {tier: int(cap) for tier, cap in ontology_schema.level_caps().items()},
        "work_items_total": sum(r["work_items"] for r in global_buckets),
        "assessed": sum(r["work_items"] for r in global_buckets
                        if r["coverage"] == "assessed"),
        "unknown": sum(r["work_items"] for r in global_buckets
                       if r["coverage"] == "unknown"),
        "untouched": sum(r["work_items"] for r in global_buckets
                         if r["coverage"] == "untouched"),
        "global": [
            {"stage": r["stage"], "coverage": r["coverage"], "work_items": r["work_items"]}
            for r in global_buckets
        ],
        "groups": by_group,
        "occupations": by_occupation,
        "markets": by_market,
    }

    # --- the chain -------------------------------------------------------------
    #
    # One file, not three, because the homepage reads a CHAIN and not three
    # tables: an update produced a reading, the reading landed on an activity,
    # the activity belongs to a market and may be held by a gate. Splitting that
    # across activities.json / evidence.json / gates.json made every page
    # re-join it, and a join the reader can see is a join the publisher should
    # have done once.
    #
    # It replaces those three files rather than sitting beside them. Two copies
    # of the same 710 readings would eventually disagree.
    caps = ontology_schema.level_caps()

    def published_level(row):
        """What the site shows, as against what the judge said.

        The judge reads an update and proposes a level; the evidence tier says
        how much that kind of source can support - a vendor's own claim (T3)
        cannot carry a reading past L2 however confident the judge was. 162 of
        the 710 readings are held down by this, so a page showing only the
        published value would be hiding the single largest effect in the method.
        Both numbers ship, and screen 2 is required to show the difference.
        """
        score = row.get("observed_level")
        # rule:score-below-one-is-not-a-level: "related, but short of L1" is
        # kept on the row as observed_score and counts for nothing.
        if score is None or float(score) < ontology_schema.min_level_score():
            return None
        observed = ontology_schema.level_of_score(score)
        cap = caps.get(row.get("evidence_tier"))
        if cap is None:
            return None
        return min(observed, int(cap))

    confirmed = {}
    for row in confirmations:
        confirmed.setdefault((row["event_id"], row["activity_id"]), []).append(confirmation(row))

    chain_evidence = [
        {
            "event_id": row["event_id"],
            "activity_id": row["activity_id"],
            # The level the judge's reading reached, and the raw score it came
            # from. Only the level is a category a page may show.
            "observed_level": ontology_schema.level_of_score(row["observed_level"]),
            "observed_score": row["observed_level"],
            "level": published_level(row),
            "evidence_tier": row["evidence_tier"],
            "confidence": row["confidence"],
            "rationale": row["rationale"],
            "status": row["status"],
            # Only on the rows someone confirmed, so the other readings stay byte for byte
            # what they were, and a site that predates the field reads past it.
            **({"confirmations": confirmed[key]} if (key := (row["event_id"], row["activity_id"])) in confirmed else {}),
        }
        for row in evidence
        if row["evidence_sign"] == "positive"
    ]

    market_of = {a["activity_id"]: a["market_id"] for a in activities}
    source_urls = {e["event_id"]: (e.get("source_urls") or []) for e in events}

    # The events that bore on some activity. The other 325 read as updates that
    # turned out to say nothing about work - they belong on /updates, and
    # putting them on this axis would imply the collection found more than it did.
    bearing = {}
    for row in chain_evidence:
        seen = bearing.setdefault(row["event_id"], {
            "activities": set(), "markets": set(), "top_level": None, "best_tier": None,
        })
        seen["activities"].add(row["activity_id"])
        market = market_of.get(row["activity_id"])
        if market:
            seen["markets"].add(market)
        if row["level"] is not None:
            seen["top_level"] = row["level"] if seen["top_level"] is None else max(seen["top_level"], row["level"])
        tier = row["evidence_tier"]
        # T1 is the strongest, so the best tier is the smallest string.
        seen["best_tier"] = tier if seen["best_tier"] is None else min(seen["best_tier"], tier)

    by_event = {}
    for row in evidence:
        by_event.setdefault(row["event_id"], row)

    chain_events = []
    for event_id, roll in bearing.items():
        head = by_event[event_id]
        chain_events.append({
            "event_id": event_id,
            "title": head["title"],
            "summary": head["summary"],
            "occurred_at": head["occurred_at"],
            "org_name": head["org_name"],
            "primary_org_id": head["primary_org_id"],
            "activities": len(roll["activities"]),
            "markets": len(roll["markets"]),
            "top_level": roll["top_level"],
            "best_tier": roll["best_tier"],
            "source_urls": source_urls.get(event_id, []),
            "subject_key": head.get("subject_key"),
            "series_size": head.get("series_size"),
            "attention": head.get("attention"),
        })
    chain_events.sort(key=lambda r: (r["occurred_at"] or "", r["event_id"]))

    # Which activity each gate holds. The per-gate COUNT was published and the
    # edges were not, so a page could say "254 activities" and could not name
    # one of them - and an activity page could not say which gate was holding
    # it. 506 rows.
    gate_edges = _clean(_rows(conn, """
        SELECT ge.gate_id, ge.activity_id, ge.confidence, ge.status
          FROM public.activity_gate_edges ge
         WHERE ge.ontology_version = %s AND ge.status IN ('candidate', 'reviewed')
         ORDER BY ge.gate_id, ge.confidence DESC NULLS LAST""", (ontology_version,)))

    chain = {
        "events": chain_events,
        "evidence": chain_evidence,
        "activities": activities,
        "gates": gates,
        "gate_edges": gate_edges,
    }

    generated_at = datetime.now(timezone.utc)

    # The model field of an update (migration 032). An update that was read and
    # names no model carries an empty list; one not read yet carries null.
    models = _clean(_rows(conn, """
        SELECT m.model_id, m.org_id, coalesce(o.canonical_name_en, m.owner_name) AS owner,
               o.canonical_name_zh_cn AS owner_zh_cn, m.level, m.parent_model_id, m.name,
               m.version, m.variant, m.released_at, m.status,
               (SELECT count(DISTINCT em.event_id) FROM public.event_models em
                 WHERE em.model_id = m.model_id) AS events
          FROM public.models m
          LEFT JOIN public.org_registry o ON o.org_id = m.org_id
         ORDER BY m.model_id"""))
    model_status = {m["model_id"]: m["status"] for m in models}
    read = {r["event_id"] for r in _rows(conn, "SELECT event_id FROM public.event_model_checks")}
    named = {}
    for r in _rows(conn, """SELECT event_id, model_id, role FROM public.event_models
                             ORDER BY event_id, model_id, role"""):
        named.setdefault(r["event_id"], []).append(
            {"model_id": r["model_id"], "role": r["role"], "status": model_status[r["model_id"]]})
    for event in events:
        event["models"] = named.get(event["event_id"], []) if event["event_id"] in read else None

    payload = {
        "chain": chain, "markets": markets, "tasks": tasks,
        "events": events, "models": models, "sources": sources(conn),
        "topics": topics(conn),
        "coverage": coverage, "progress": progress,
    }
    manifest = {
        "snapshot_version": SNAPSHOT_VERSION,
        "generated_at": generated_at.isoformat(),
        "ontology_version": ontology_version,
        "schema_version": ontology_schema.SCHEMA_VERSION,
        "method_version": METHOD_VERSION,
        # chain is four lists in one file, so counting it as "1" would publish a
        # manifest that cannot be checked against the file it describes.
        "counts": {
            **{f"chain.{k}": len(v) for k, v in chain.items()},
            **{k: len(v) for k, v in payload.items() if isinstance(v, list)},
            **{k: 1 for k, v in payload.items() if isinstance(v, dict) and k != "chain"},
        },
        "content_sha256": digest(payload),
        "edges_per_subject": EDGES_PER_SUBJECT,
        # What a reader has to know before reading a single number. These are not
        # disclaimers: each one names a specific way the figures on the page can
        # be misread, and the collection caveat is the most important of them.
        "caveats": {
            "en": [
                "Progress is computed from market activities. Each activity is scored on "
                "what published updates actually describe, and every activity-to-task "
                "edge, every gate and every reading behind it is machine-proposed and "
                "unreviewed. None has been confirmed by a person.",
                "A task's level is the LOWEST of the activities covering it, because a "
                "task needs all of its work done. Evidence caps what that level may "
                "reach - an independent measurement supports L5, a named adopter L4, a "
                "vendor's own claim L2, a bare demo L1 - and an activity held by a gate "
                "stays at L0, since a condition that does not lift when models improve "
                "is not a question about what software can do.",
                "Three states are counted separately and none of them is zero. assessed "
                "means every covering activity has evidence; unknown means at least one "
                "does not, so the minimum cannot be known; untouched means no activity "
                "covers the task at all. Most of the catalogue is untouched: no update "
                "in the collected window said anything about that work.",
                "The evidence is what a few weeks of collection happened to contain, and "
                "it is not evenly spread across publishers. An empty market means nothing "
                "was collected about it, never that AI has no bearing on it. "
                "coverage.events_by_organisation and coverage.collection_window give the "
                "shape of that skew.",
                "Of the updates read, fewer than half bore on any activity at all. "
                "coverage.events_routed and coverage.events_bearing_on_activity carry "
                "both counts, because an update that turned out to say nothing about "
                "work is a result, not a gap in the record.",
                "L5 is published while empty. No work anywhere was found running with "
                "nobody, and an empty top rung is the finding - a scale that quietly "
                "ended at L4 would hide it.",
                "Nothing here has been reviewed by a person. The reviewed count is zero "
                "and is published as zero rather than estimated.",
            ],
            "zh-CN": [
                "进度由赛道活动算出。每条活动依据已发布更新实际描述的内容评级，其背后的"
                "活动—任务边、闸门与每一次读数，全部由机器提出且未经复核，没有一条经过人确认。",
                "一条任务的层级取覆盖它的各条活动中**最低**的那个——任务要整件做完才算做完。"
                "证据决定这个层级最高能到哪：独立测量可支持 L5，具名采用方 L4，厂商自证 L2，"
                "仅有演示 L1；被闸门挡住的活动停在 L0，因为一个不随模型变强而松动的条件，"
                "问的已经不是软件能做什么。",
                "已判定、未知、未触及分开计数，没有一种等于 0。已判定指覆盖该任务的每条活动"
                "都有证据；未知指至少有一条没有，因此最小值无从得知；未触及指没有任何活动覆盖它。"
                "目录中绝大部分是未触及：采集窗口里没有一条更新谈到那份工作。",
                "证据只是几周采集恰好收到的东西，且在发布方之间分布很不均匀。某个赛道是空的，"
                "只说明没有采集到关于它的内容，绝不说明 AI 与它无关。"
                "coverage.events_by_organisation 和 coverage.collection_window 给出这种偏斜的形状。",
                "读过的更新里，不到一半真正谈到了任何一条活动。coverage.events_routed 与 "
                "coverage.events_bearing_on_activity 两个数都公布——一条读完发现与工作无关的更新，"
                "是一个结果，不是记录上的缺口。",
                "L5 在为空的情况下照样公布。没有找到任何一份工作在无人参与下运行，"
                "空着的最高档本身就是结论；一把悄悄止于 L4 的尺子会把它藏起来。",
                "这里没有任何一条经过人工复核。已复核数为 0，按 0 公布，不做估计。",
            ],
        },
    }
    return {"manifest": manifest, **payload}


def write(conn, ontology_version: str | None = None, directory: Path | None = None) -> dict:
    """Write one published snapshot.

    Only `latest` is kept: the manifest carries the generation date and content
    hash, and git already holds every earlier version. Writing a dated copy
    beside it would double the repository for history version control provides.
    """
    snapshot = build(conn, ontology_version)
    target = directory or (PUBLISHED / "latest")
    target.mkdir(parents=True, exist_ok=True)
    written = []
    for name, value in snapshot.items():
        path = target / f"{name}.json"
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        written.append(str(path.relative_to(ROOT)))

    # A snapshot is the whole published state, so a file this build no longer
    # produces is not history - it is a stale answer sitting next to the current
    # one, and a reader has no way to tell which is which. The capability layer
    # left four such files behind, one of them 7.7 MB.
    removed = sorted(path.name for path in target.glob("*.json")
                     if path.stem not in snapshot)
    for name in removed:
        (target / name).unlink()

    return {"directory": str(target.relative_to(ROOT)), "files": written,
            "removed": removed,
            "generated_at": snapshot["manifest"]["generated_at"],
            "counts": snapshot["manifest"]["counts"],
            "content_sha256": snapshot["manifest"]["content_sha256"]}
