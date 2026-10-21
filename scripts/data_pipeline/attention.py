"""Attention: how much notice an update drew (rule:attention-baseline).

Kept strictly apart from capability. A like is not evidence that AI can do
anything (the project's evidence rules forbid capability points for
engagement), so nothing in this module is read by any level computation. It
decides what is worth a reader's attention and which updates are important
enough to go looking for third-party verification.

Ranked by engagement, not views: ranked by views against the account's own
median, the top ten were paid promotions - thousands of times an account's
usual views and almost no likes. Engagement takes a person to click. The
multiple of the account's median engagement is kept alongside, and every post
is read at day 7 (rule:attention-baseline: two captures, first seen and day 7);
before day 7 the number is provisional.
"""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from datetime import datetime

from . import ontology_schema


def _rule(model=None):
    return ontology_schema.rule("rule:attention-baseline", model)["expression"]


def _hours(later: datetime, earlier: datetime) -> float:
    return (later - earlier).total_seconds() / 3600


def pick_capture(captures, published_at, model=None):
    """The snapshot to read a post at, and its age in hours; (None, None) if none.

    The final reading is the one nearest day 7 inside the window; before one
    exists the latest capture stands in, and is_provisional says so.
    """
    if not captures:
        return None, None
    low, high = _rule(model)["final_snapshot_age_hours"]
    target = (low + high) / 2
    aged = [(c, _hours(c["captured_at"], published_at)) for c in captures]
    inside = [(c, age) for c, age in aged if low <= age <= high]
    if inside:
        return min(inside, key=lambda pair: abs(pair[1] - target))
    return max(aged, key=lambda pair: pair[0]["captured_at"])


def is_provisional(age_hours, model=None):
    """True until a capture reaches the day-7 window."""
    return age_hours is None or age_hours < _rule(model)["final_snapshot_age_hours"][0]


def engagement(metrics, model=None):
    """Sum of the counted interactions; None when none of them was returned."""
    fields = _rule(model)["engagement"]
    present = [metrics.get(f) for f in fields if metrics.get(f) is not None]
    return sum(present) if present else None


def post_ratios(posts, field="engagement"):
    """field / median field of the same account; None when either is unknown or zero."""
    by_account = defaultdict(list)
    for post in posts.values():
        if post.get(field) is not None:
            by_account[post["handle"]].append(post[field])
    baseline = {h: statistics.median(v) for h, v in by_account.items()}
    ratios = {}
    for key, post in posts.items():
        base = baseline.get(post["handle"])
        value = post.get(field)
        ratios[key] = None if value is None or not base else round(value / base, 3)
    return ratios


def event_attention(links, posts, ratios):
    """Per event: its most-engaged post, with that post's raw numbers and ratio."""
    out = {}
    for event_id, source_ids in links.items():
        measured = [s for s in source_ids if posts.get(s, {}).get("engagement") is not None]
        if not measured:
            out[event_id] = {"engagement": None, "ratio": None, "views": None, "likes": None,
                             "snapshot_age_hours": None, "posts": len(source_ids), "source_id": None,
                             "provisional": True}
            continue
        best = max(measured, key=lambda s: posts[s]["engagement"])
        post = posts[best]
        out[event_id] = {"engagement": post["engagement"], "ratio": ratios.get(best),
                         "views": post.get("views"), "likes": post.get("likes"),
                         "snapshot_age_hours": post.get("age_hours"), "posts": len(source_ids),
                         "source_id": best, "provisional": is_provisional(post.get("age_hours"))}
    return out


def percentiles(values):
    """Rank in [0, 1] among measured values; unmeasured stay None."""
    measured = sorted(v for v in values.values() if v is not None)
    if len(measured) < 2:
        return {k: (None if v is None else 1.0) for k, v in values.items()}
    span = len(measured) - 1
    return {k: None if v is None else round(measured.index(v) / span, 3) for k, v in values.items()}


def series_sizes(events):
    """How many published updates share each subject; singletons are not a series."""
    counts = Counter(e["subject_key"] for e in events if e.get("subject_key"))
    return {key: n for key, n in counts.items() if n > 1}


CAPTURES_SQL = """
    SELECT cs.source_id, cs.account_handle, cs.published_at, cc.captured_at, cc.metrics
      FROM public.collected_sources cs
      JOIN public.collected_captures cc ON cc.source_id = cs.source_id
     WHERE NOT coalesce(cs.is_repost, false) AND cs.published_at IS NOT NULL
"""

LINKS_SQL = """
    SELECT s.event_id, s.source_id
      FROM public.extracted_event_sources s
      JOIN public.extracted_events e ON e.event_id = s.event_id
     WHERE e.kind_vocabulary = ANY(%s)
"""


def compute(capture_rows, link_rows):
    """Everything the publisher needs, from the two query results."""
    grouped = defaultdict(list)
    meta = {}
    for row in capture_rows:
        grouped[row["source_id"]].append(row)
        meta[row["source_id"]] = row
    posts = {}
    for source_id, caps in grouped.items():
        chosen, age = pick_capture(caps, meta[source_id]["published_at"])
        metrics = (chosen or {}).get("metrics") or {}
        posts[source_id] = {"handle": meta[source_id]["account_handle"], "views": metrics.get("views"),
                            "likes": metrics.get("likes"), "engagement": engagement(metrics),
                            "age_hours": None if age is None else round(age)}
    ratios = post_ratios(posts)
    links = defaultdict(list)
    for row in link_rows:
        links[row["event_id"]].append(row["source_id"])
    per_event = event_attention(links, posts, ratios)
    # One post can announce several things ("Fable 5.1 and Mythos 5.1"); each
    # event keeps the attention, and says how many events share that post so a
    # ranking can count the post once.
    shared = Counter(v["source_id"] for v in per_event.values() if v["source_id"])
    for value in per_event.values():
        value["shared_by_events"] = shared.get(value["source_id"], 0) if value["source_id"] else 0
    # Only final readings are ranked; a provisional one gets no percentile.
    ranks = percentiles({k: (None if v["provisional"] else v["engagement"]) for k, v in per_event.items()})
    for event_id, value in per_event.items():
        value["percentile"] = ranks[event_id]
    return per_event
