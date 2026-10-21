"""Which posts belong to which event (rule:post-links-to-event).

Posts are related, not accounts classified. An event is extracted from some
official posts; everything that answers, quotes or reposts those posts - and
whatever answers those in turn - belongs to the same event, found by walking
the upstream links kept on collected_sources. These links are facts in the raw
data, so this step judges nothing. A post with no upstream that names the
product in the week after the event is a weaker `mention`, whose content the
judge still has to confirm.

event_posts is derived and rebuilt in full; nothing here is edited in place.
"""
from __future__ import annotations

import re
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from . import ontology_schema
from .ontology_schema import EVENT_KIND_VOCABULARIES

UPSTREAM = (("reply_to", "reply"), ("quote_of", "quote"), ("repost_of", "repost"))


def _rule(model=None):
    return ontology_schema.rule("rule:post-links-to-event", model)["expression"]


def mentions(text, terms):
    """Every search word appears as a whole word (hyphens count as breaks)."""
    words = set(re.findall(r"[a-z0-9]+", (text or "").lower()))
    return bool(terms) and all(t in words for t in terms.split())


def subject_terms(subject_key):
    return None if not subject_key else " ".join(subject_key.split("-"))


def build_links(seeds, posts, events, model=None):
    """[(event_id, source_id, link, depth, via_source_id)] - pure.

    seeds: {event_id: [source post ids]}; posts: {source_id: {reply_to,
    quote_of, repost_of, published_at, text}}; events: {event_id:
    {occurred_at, terms}}.
    """
    rule = _rule(model)
    followed = set(rule["follow"])
    children = defaultdict(list)
    for sid, p in posts.items():
        for field, kind in UPSTREAM:
            target = p.get(field)
            if target and kind in followed:
                children[target].append((sid, kind))
    out, chained = [], set()
    for event_id, sources in seeds.items():
        linked = {}
        queue = deque()
        for sid in sources:
            if sid not in linked:
                linked[sid] = ("source", 0, None)
                queue.append((sid, 0))
        while queue:
            node, depth = queue.popleft()
            if depth >= rule["max_depth"]:
                continue
            for child, kind in children.get(node, ()):
                if child not in linked:
                    linked[child] = (kind, depth + 1, node)
                    queue.append((child, depth + 1))
        out.extend((event_id, sid, *value) for sid, value in linked.items())
        chained.update((event_id, sid) for sid in linked)
    # Mentions: a post with no upstream goes to ONE event - the most specific
    # product it names, then the latest such event before it. Linking it to
    # every event of a series ("introduces", "in Foundry", "rolled out") counted
    # one opinion four times.
    days = timedelta(days=rule["mention_within_days"])
    named = [(eid, m["terms"], m["occurred_at"]) for eid, m in events.items()
             if m.get("terms") and m.get("occurred_at")]
    # A subject whose words begin another subject is a brand, not a product
    # ("gemini" vs "gemini 3 8 flash"): matching it would hand every post about
    # the brand to whichever event happened to carry the bare name.
    all_terms = {t for _, t, _ in named}
    broad = {t for t in all_terms if any(o != t and o.startswith(t + " ") for o in all_terms)}
    named = [n for n in named if n[1] not in broad]
    for sid, p in posts.items():
        if p.get("repost_of"):  # a repost has no words of its own
            continue
        hits = [(eid, terms, at) for eid, terms, at in named
                if at <= p["published_at"] <= at + days and mentions(p.get("text"), terms)
                and (eid, sid) not in chained]
        if not hits:
            continue
        widest = max(len(t.split()) for _, t, _ in hits)
        hits = [h for h in hits if len(h[1].split()) == widest]
        latest = max(at for _, _, at in hits)
        for eid, _, at in hits:
            if at == latest:
                out.append((eid, sid, "mention", 1, None))
    return out


SEEDS_SQL = """
    SELECT s.event_id, s.source_id, e.occurred_at, e.subject_key
      FROM public.extracted_event_sources s
      JOIN public.extracted_events e ON e.event_id = s.event_id
     WHERE e.kind_vocabulary = ANY(%s)
"""

POSTS_SQL = """
    SELECT DISTINCT ON (cs.source_id)
           cs.source_id, cs.reply_to_source_id AS reply_to, cs.quoted_source_id AS quote_of,
           cs.repost_of_source_id AS repost_of, cs.published_at,
           coalesce(cc.full_text, cc.public_excerpt) AS text
      FROM public.collected_sources cs
      LEFT JOIN public.collected_captures cc ON cc.source_id = cs.source_id
     WHERE cs.published_at IS NOT NULL
     ORDER BY cs.source_id, cc.captured_at DESC NULLS LAST
"""


ATTACHED_SQL = """
    SELECT a.event_id, a.source_id FROM public.extracted_event_attachments a
      JOIN public.extracted_events e ON e.event_id = a.event_id
     WHERE e.kind_vocabulary = ANY(%s)
"""


def with_attached(rows, attached):
    """Add posts the extractor attached by reading them; a link already found stays.

    A post that replies to the announcement and was also read as saying
    something about it is one post of that event, and the raw link is the fact.
    """
    linked = {(row[0], row[1]) for row in rows}
    return rows + [(event_id, source_id, "attached", 1, None)
                   for event_id, source_id in attached if (event_id, source_id) not in linked]


def rebuild(conn, model=None):
    """Recompute event_posts from the collected facts. Returns counts by link."""
    seeds, events = defaultdict(list), {}
    for r in conn.execute(SEEDS_SQL, (EVENT_KIND_VOCABULARIES,)).fetchall():
        seeds[r["event_id"]].append(r["source_id"])
        events[r["event_id"]] = {"occurred_at": r["occurred_at"], "terms": subject_terms(r["subject_key"])}
    posts = {r["source_id"]: dict(r) for r in conn.execute(POSTS_SQL).fetchall()}
    rows = build_links(seeds, posts, events, model)
    rows = with_attached(rows, [(r["event_id"], r["source_id"])
                                for r in conn.execute(ATTACHED_SQL, (EVENT_KIND_VOCABULARIES,)).fetchall()])
    built = datetime.now(timezone.utc)
    with conn.transaction():
        conn.execute("DELETE FROM public.event_posts")
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO public.event_posts (event_id, source_id, link, depth, via_source_id, built_at)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                [(*row, built) for row in rows])
    counts = defaultdict(int)
    for row in rows:
        counts[row[2]] += 1
    return dict(counts)
