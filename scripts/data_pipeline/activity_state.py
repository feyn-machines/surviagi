"""How far AI has got, computed once at the task level.

Three rules, in this order:

  1. **An activity's level is capped by the kind of evidence behind it.** A
     vendor saying so is not a named adopter running it, and neither is an
     independent measurement. Without this cap, "we launched X for lawyers"
     reads the same as "a firm has been running X for a year".

  2. **A task's level is the LOWEST of the activities covering it.** A task
     needs all of its work done, so AI failing at any part means the task is not
     done. Taking the highest is what put baggage porters at 59%: greeting guests
     matched a communication activity, and carrying the bags was ignored.

  3. **A gate caps the activity at L3** (rule:gate-caps-level). A condition that
     does not lift when models improve - a clinician must sign, a person must be
     present - rules out delivery with no person (L4/L5). It does not show that
     AI takes no part, which is what L0 says; an AI update cannot show that.

  4. **A judge score below 1 is not a level** (rule:score-below-one-is-not-a-level).
     It says "related, but short of L1" and is kept on record only.

Everything above this is arithmetic: an occupation is its tasks, a market is its
activities' tasks, the world is all tasks. No judge is called again.
"""
from __future__ import annotations

from datetime import datetime, timezone

from . import ontology_schema

# What the strongest evidence of each kind is allowed to support. A claim with
# nothing behind it cannot put work past "AI helps in places", however confident
# the claim sounds. Read from evidence_tier.level_cap rather than written here:
# these numbers used to live in Python in three places while the schema
# carried a DIFFERENT set for the retired 0-4 scale, and only T3 agreeing at 2
# in both kept the divergence invisible.
TIER_CAP = ontology_schema.level_caps()

LEVELS = ontology_schema.level_ids()

# A task and an activity are both kind='work'. The ontology separates them by
# relation, not by kind: a task is the child of a has_task edge, an activity the
# child of a has_work edge. The two sets are disjoint and cover every work
# concept (18,838 + 614 = 19,452), so this predicate is exact rather than a
# prefix guess.
#
# Counting them together is not a rounding error: every activity lands in the
# grid as a square nothing can ever cover, so the chart grows 614 permanently
# untouched cells that stand for no work at all.
IS_TASK = """EXISTS (SELECT 1 FROM public.ontology_relations r
         WHERE r.ontology_version = w.ontology_version
           AND r.child_id = w.id AND r.kind = 'has_task')"""


def readings_sql(versioned: bool = False) -> str:
    """Every counted reading as (activity_id, level, evidence_tier).

    Two sources, one shape: a vendor's reading of its own update, and a panel
    post that verified or corroborated a held-down claim. Each is capped by its
    own tier, so a third-party T1 confirmation can carry what the vendor's T3
    claim could not. With `versioned`, each branch takes one %s ontology_version.
    """
    version = lambda t: f"AND {t}.ontology_version = %s" if versioned else ""
    return f"""
  SELECT ae.activity_id,
         LEAST({ontology_schema.level_of_score_sql("ae.observed_level")}, {ontology_schema.level_cap_sql()}) AS level,
         ae.evidence_tier
    FROM public.activity_evidence ae
   WHERE ae.evidence_sign = 'positive'
     AND ae.status IN ('candidate', 'reviewed')
     AND ae.observed_level IS NOT NULL
     AND ae.observed_level >= {ontology_schema.min_level_score()}
     {version("ae")}
  UNION ALL
  SELECT ve.activity_id,
         LEAST(ve.observed_level, {ontology_schema.level_cap_sql("ve.evidence_tier")},
               {ontology_schema.nature_cap_sql("ve.post_nature")}) AS level,
         ve.evidence_tier
    FROM public.verification_evidence ve
   WHERE ve.status IN ('candidate', 'reviewed')
     AND ve.evidence_tier IS NOT NULL
     AND ve.observed_level IS NOT NULL
     {version("ve")}"""


ACTIVITY_LEVEL_SQL = f"""
WITH capped AS ({readings_sql()}
),
best AS (
  SELECT activity_id, max(level) AS level,
         min(evidence_tier) AS best_tier, count(*) AS evidence_rows
    FROM capped GROUP BY 1
),
gated AS (
  SELECT b.activity_id,
         CASE WHEN g.activity_id IS NOT NULL THEN LEAST(b.level, {ontology_schema.gate_level_cap()}) ELSE b.level END AS level,
         b.best_tier, b.evidence_rows,
         (g.activity_id IS NOT NULL) AS gated
    FROM best b
    LEFT JOIN LATERAL (
      SELECT ge.activity_id FROM public.activity_gate_edges ge
       WHERE ge.activity_id = b.activity_id
         AND ge.status IN ('candidate', 'reviewed') LIMIT 1) g ON TRUE
)
SELECT * FROM gated
"""

TASK_LEVEL_SQL = f"""
WITH activity AS ({ACTIVITY_LEVEL_SQL}),
covered AS (
  SELECT ate.task_id, ate.activity_id, a.level
    FROM public.activity_task_edges ate
    LEFT JOIN activity a ON a.activity_id = ate.activity_id
   WHERE ate.status IN ('candidate', 'reviewed')
)
SELECT c.task_id,
       -- The lowest activity wins; a covering activity with no evidence makes
       -- the task unknown rather than zero, which is what the null marks.
       CASE WHEN bool_or(c.level IS NULL) THEN NULL ELSE min(c.level) END AS level,
       count(*) AS activities,
       count(*) FILTER (WHERE c.level IS NULL) AS activities_without_evidence
  FROM covered c
 GROUP BY 1
"""


def task_levels(conn) -> list[dict]:
    return conn.execute(TASK_LEVEL_SQL).fetchall()


def summary(conn, ontology_version: str = "1.0.0") -> dict:
    """The three states, counted. Unknown is not zero and never has been.

    - assessed: every activity covering the task has evidence behind it
    - unknown: at least one covering activity has none, so the minimum is unknown
    - untouched: no activity covers the task at all
    """
    total = conn.execute(
        f"""SELECT count(*) AS n FROM public.ontology_concepts w
             WHERE w.kind = 'work' AND w.ontology_version = %s AND {IS_TASK}""",
        (ontology_version,),
    ).fetchone()["n"]
    rows = task_levels(conn)
    assessed = [row for row in rows if row["level"] is not None]
    unknown = len(rows) - len(assessed)
    buckets = {level: 0 for level in LEVELS}
    for row in assessed:
        buckets[int(row["level"])] += 1
    return {
        "as_of": datetime.now(timezone.utc).isoformat(),
        "work_items_total": total,
        "assessed": len(assessed),
        "unknown": unknown,
        "untouched": total - len(rows),
        "by_level": buckets,
        # Published even when empty: an absent L5 is the headline of the chart.
        "levels": LEVELS,
        "tier_caps": TIER_CAP,
    }
