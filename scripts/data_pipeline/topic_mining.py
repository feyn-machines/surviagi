"""Topics: the standing questions a day's posts argue about.

An update is something that happened once. A topic is a closed question about
one occupation or one market - "does the job of prompt engineer still exist?" -
that stays open while claims and updates collect under its answers.

Mining reads a window of posts in two passes:

1. Every post by a person or a third-party organisation is read for a claim:
   which job or business it is about, which kind of question it answers, and
   the answer its author asserts. Most posts make no such claim.
2. Claims are taken in the order they were posted. Each is put under an answer
   of a topic that is already open, or opens a new topic, or is left out as too
   vague to be a question. A day gives claims; topics are what they add up to.

Whether a claim belongs to an open topic is a judgment, not a key: "accountant"
and "junior accountant" are one question, "prompt engineer" and "junior
developer" are two although the catalog puts both under software developers. A
local embedding shortlists the few open topics and catalog entries worth
showing the judge; the score itself decides nothing.

The accounts we collect lean one way, so most topics arrive with every claim on
one side. Such a topic is `one_sided`: the answer nobody argued is written out,
with search phrases aimed at it. It is what a search goes looking for next.

Nothing here decides an answer. A count of accounts under an option says who
argued it in the posts we collected, not how many people think so.

Topics, their answers and the claims under them are rows in PostgreSQL
(ontology schema 2.3.0); each run also leaves a document under data/ that is
never overwritten. Read by calendar quarter, a topic shows how the argument
moved; no outcome is ever declared (rule:topic-carries-no-answer).
"""

import hashlib
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor

from . import deepseek, embedding, ontology_schema
from .event_extraction import quoted_in

VERSION = "topic-mining-7"
QUESTION_TYPES = tuple(ontology_schema.term_ids("topic_question_type"))
OBJECT_KINDS = {"replacement": "occupation", "viability": "market"}
_STANDARD = ontology_schema.rule("rule:topic-is-a-closed-question")["expression"]
CHECKS = tuple(_STANDARD["checks"])
MIN_OPTIONS, MAX_OPTIONS = _STANDARD["min_options"], _STANDARD["max_options"]
# How many stored topics and catalog entries the judge is shown for one claim,
# and how alike a topic must be to be shown at all.
TOPIC_SHORTLIST, CATALOG_SHORTLIST, TOPIC_FLOOR = 6, 8, 0.6

CLAIM_PROMPT = """You read posts about AI and pick out the ones that take a position on one of two kinds of question.

replacement - whether AI does, or will do, the work of a specific job or a specific kind of work, so that the job shrinks, changes into something else, or disappears. The object is that job or kind of work (for example "prompt engineer", "junior software engineer", "radiologist", "customer support agent").

viability - whether a specific kind of product or business is still worth building or paying for now that AI can do it. The object is that kind of product or business (for example "AI wrapper apps", "indie SaaS products", "translation agencies", "game studios").

The object is always human work or a business - never an AI model or tool. One model being better or worse than another, or one tool replacing another tool, is not a claim of either kind.

A post counts only when its author asserts an answer about a SPECIFIC object. Leave a post out when it is news of a release, a benchmark number with no conclusion about a job or business, a joke, a reaction, an advertisement, a general remark about AI, society, intelligence or "the future of work", or about a whole discipline, "knowledge workers" or "everyone".

Return JSON: {"claims": [{"id": the post id, "question_type": "replacement" or "viability", "object": the job or kind of business in a few plain English words (singular, lower case, no adjectives of opinion), "claim": one sentence in English stating what the author asserts about that object, without naming the author, "quote": the words of the post, copied exactly and in its own language, that carry the assertion (one sentence or less)}]}. A post gives at most one claim. Return {"claims": []} when none qualifies."""

# How an answer is written (rule:topic-is-a-closed-question). An answer worded as
# "AI handles the routine work, but most people move to harder work and keep
# their jobs" concedes one thing and concludes another: a reader cannot see the
# position at a glance, and no measured result is evidence for the whole of it.
OPTION_MAX_WORDS = _STANDARD["option_max_words_en"]
OPTION_STYLE = (
    f"Write each option as ONE short plain statement of how things stand, at most {OPTION_MAX_WORDS} "
    "English words: something a measured result, a real deployment or a failure could show to be so or "
    "not so. No \"but\", \"so\", \"because\" or \"while\"; no reasons; no stock phrase that would fit any job. "
    "For example, for \"Will AI replace most accountants?\": \"AI does most accounting work; far fewer "
    "accountants are needed\" is too long - write \"Far fewer accountants are needed\", \"Accountants "
    "stay, doing different work\", \"AI cannot do accounting work reliably\"."
)

PLACE_PROMPT = """You keep a list of topics. A topic is a closed question about ONE job or ONE kind of business, with 2 to 4 answers that exclude each other. You are given one new claim an account made, the open topics most like it, and catalog entries it might belong to. Decide what to do with the claim.

"attach" - the claim answers the question of one of the open topics. Prefer this whenever it honestly fits: the same question must not be opened twice. The object must be the same thing at the level the question is asked: "junior accountant" answers a question about accountants, and "SaaS apps" or "professional software" answer a question about whether selling software is still a business; "prompt engineer" does not answer a question about software developers, it is a different job. Say which answer the claim takes. If it takes a position none of the answers covers and the topic has fewer than 4 answers, write that answer as "new_option"; otherwise pick the nearest answer.

"new" - no open topic asks what this claim answers. Write the topic:
- It names the specific object.
- One short question of at most 15 words that a reader answers by picking an option, in the plain form people ask it: "Will AI replace most accountants?", "Does the job of prompt engineer still exist?", "Is selling software still a viable business?". Never "what happens to X when ...", "what does X mean for Y", "how will X change", "which X first", and no conditions or lists inside the question.
- 2 to 4 options that exclude each other, worded neutrally. One is the position the claim takes; write the opposing position as well even though nobody has argued it yet.
- """ + OPTION_STYLE + """
- Later evidence (a measured result, a real deployment, a failure) could favour one option.
- 2 or 3 short search phrases in the words people actually use on X that would find posts arguing this question, at least one aimed at the side the claim does NOT take.
- "catalog_id": the ONE catalog entry that is this thing or clearly contains it - an occupation for a job, a market for a business - or null when none is. A wrong match is worse than none.
- Check it honestly: "specific" (one job or one kind of business, not a field), "closed", "exclusive", "movable".

"none" - the claim is too vague to be a question of this kind, or its object is not a job people hold or a business people run (a programming language, a tool, a habit, a way of working, a hiring practice are none of these; a line of work people are hired for, such as prompt engineering or video editing, IS a job). Give the reason.

Return JSON, one of:
{"decision": "attach", "topic": topic id, "option": option key} or {"decision": "attach", "topic": topic id, "new_option": {"en": ..., "zh-CN": ...}}
{"decision": "new", "object": canonical name of the job or business (singular, lower case), "catalog_id": id or null, "question": {"en": ..., "zh-CN": ...}, "options": [{"key": "a", "en": ..., "zh-CN": ...}], "claim_option": key of the option this claim takes, "queries": [...], "checks": {"specific": bool, "closed": bool, "exclusive": bool, "movable": bool}}
{"decision": "none", "reason": ...}
Write the Chinese as natural Simplified Chinese, not a word-for-word translation."""


def _ask(system, user, cfg, attempts=3):
    """One model call with retries; None when every attempt failed."""
    for attempt in range(attempts):
        try:
            return deepseek.chat([{"role": "system", "content": system},
                                  {"role": "user", "content": user}], cfg, timeout=180)
        except deepseek.DeepSeekError:
            time.sleep(2 * (attempt + 1))
    return None


def _norm(text):
    return re.sub(r"\s+", " ", str(text or "").strip().lower())


def _pair(value):
    """A {"en", "zh-CN"} pair of non-empty texts, or None."""
    if not isinstance(value, dict):
        return None
    pair = {name: str(value.get(name) or "").strip() for name in ("en", "zh-CN")}
    return pair if all(pair.values()) else None


def load_posts(conn, window, collection_runs=None):
    """Original posts in the window by people and third-party organisations.

    `collection_runs` narrows to the posts of those runs - a search made for
    the topics, say - so the rest of the window is not read again.

    A company's own account announces; it does not argue about jobs or markets,
    and what it says about itself is a vendor claim. Reposts and replies are
    left out as they are for updates.
    """
    rows = conn.execute("""
        SELECT DISTINCT ON (s.source_id)
               s.source_id, s.account_handle, s.canonical_url, s.published_at,
               COALESCE(c.full_text, c.public_excerpt, '') AS text, c.metrics, a.panel_role
        FROM collected_sources s
        JOIN collected_captures c ON c.run_id = s.run_id AND c.source_id = s.source_id
        LEFT JOIN source_accounts a
               ON a.platform = s.platform AND a.platform_account_id = s.account_external_id
        WHERE NOT s.is_repost AND NOT s.is_reply
          AND s.published_at >= %(start)s AND s.published_at < %(end)s
          AND a.panel_role IS DISTINCT FROM 'official'
          AND (%(runs)s::text[] IS NULL OR s.run_id = ANY(%(runs)s))
        ORDER BY s.source_id, c.captured_at DESC
    """, {**window, "runs": list(collection_runs) if collection_runs else None}).fetchall()
    posts = [{"id": r["source_id"], "handle": r["account_handle"], "url": r["canonical_url"],
              "published_at": r["published_at"].isoformat(), "text": r["text"],
              "views": int((r["metrics"] or {}).get("views") or 0)}
             for r in rows if len(r["text"]) >= 40]
    posts.sort(key=lambda p: (p["published_at"], p["id"]))
    return posts


def load_catalog(conn):
    """Occupations and markets of the newest sealed catalog: id -> names."""
    rows = conn.execute("""
        SELECT id, kind, label_en, label_zh_cn FROM ontology_concepts
        WHERE kind IN ('occupation', 'market', 'market_group')
          AND ontology_version = (SELECT max(ontology_version) FROM ontology_concepts)
        ORDER BY id
    """).fetchall()
    return {r["id"]: {"en": r["label_en"], "zh-CN": r["label_zh_cn"]} for r in rows}


def read_claims(posts, cfg, batch_size=25, workers=4, progress=None):
    """Pass 1. Returns (claims in posting order, failed batch count)."""
    by_id = {p["id"]: p for p in posts}
    chunks = [posts[i:i + batch_size] for i in range(0, len(posts), batch_size)]

    def one(numbered):
        number, chunk = numbered
        user = "Posts:\n" + "\n".join(json.dumps(
            {"id": p["id"], "author": "@" + str(p["handle"]), "text": p["text"][:1500]},
            ensure_ascii=False) for p in chunk)
        result = _ask(CLAIM_PROMPT, user, cfg)
        if progress:
            progress(number, len(chunks))
        if not isinstance(result, dict):
            return None
        return [c for c in result.get("claims") or [] if isinstance(c, dict)]

    numbered = list(enumerate(chunks, 1))
    if workers > 1:
        with ThreadPoolExecutor(workers) as pool:
            batches = list(pool.map(one, numbered))
    else:
        batches = [one(item) for item in numbered]
    claims, failed, seen = [], 0, set()
    for found in batches:
        if found is None:
            failed += 1
            continue
        for raw in found:
            post = by_id.get(str(raw.get("id")))
            kind, obj, said = raw.get("question_type"), _norm(raw.get("object")), str(raw.get("claim") or "").strip()
            # A claim the model put on a post it was not shown, or of a kind we do not ask, is not a claim.
            if post and kind in QUESTION_TYPES and obj and said and post["id"] not in seen:
                seen.add(post["id"])
                quote = str(raw.get("quote") or "").strip()
                claims.append({"id": post["id"], "question_type": kind, "object": obj, "claim": said,
                               # Words the post does not contain are the model's, not the author's.
                               "quote": quote if quote and quoted_in(quote, [(post["id"], post["text"])]) else None,
                               "handle": post["handle"], "url": post["url"],
                               "published_at": post["published_at"], "views": post["views"]})
    claims.sort(key=lambda c: (c["published_at"], c["id"]))
    return claims, failed


def topic_id(question_type, obj):
    """The id follows the identity - kind of question and object - and nothing that may be reworded."""
    digest = hashlib.sha256(f"{question_type}|{obj}".encode()).hexdigest()[:8]
    slug = re.sub(r"[^a-z0-9]+", "-", obj).strip("-")[:40]
    return f"topic:{question_type}:{slug}:{digest}"


def option_id(topic, key):
    return f"{topic}#{key}"


def quarter(day):
    """The calendar quarter (UTC) a date falls in, as 2026-Q4 (rule:topics-are-read-by-quarter)."""
    return f"{day[:4]}-Q{(int(day[5:7]) + 2) // 3}"


def _topic_text(topic):
    return f"{topic['object']}. {topic['question']['en']}"


def _claim_text(claim):
    return f"{claim['object']}. {claim['claim']}"


def describe(topic):
    """Where a topic stands, counted from the claims placed under its answers."""
    by_option = {}
    for claim in topic["claims"]:
        by_option.setdefault(claim["option"], set()).add(claim["handle"])
    quarters = {}
    for claim in topic["claims"]:
        quarters.setdefault(quarter(claim["published_at"]), {}).setdefault(claim["option"], set()).add(claim["handle"])
    options = [{**o, "accounts": len(by_option.get(o["key"], ()))} for o in topic["options"]]
    argued = sum(1 for o in options if o["accounts"])
    sound = all(topic["checks"].get(name) for name in CHECKS) and MIN_OPTIONS <= len(options) <= MAX_OPTIONS
    # Two answers that each have someone arguing them make a question with two sides,
    # whether or not a third answer is still waiting for a voice.
    status = "fails" if not sound else "open" if argued >= 2 else "one_sided"
    return {**topic, "options": options, "status": status,
            # Accounts arguing each answer, quarter by quarter: how the argument moved, not who is right.
            "by_quarter": {period: {key: len(handles) for key, handles in sorted(found.items())}
                           for period, found in sorted(quarters.items())},
            "accounts": len({c["handle"] for c in topic["claims"]}), "posts": len(topic["claims"]),
            "days": sorted({c["published_at"][:10] for c in topic["claims"]}),
            "views": sum(c["views"] for c in topic["claims"])}


class Placer:
    """Pass 2: puts claims, one at a time, under the topics kept so far."""

    def __init__(self, topics, catalog, cfg, embed_cfg=None):
        self.catalog, self.cfg, self.embed_cfg = catalog, cfg, embed_cfg
        self.topics = {t["id"]: {**t, "claims": list(t["claims"]), "options": [
            {k: o[k] for k in ("key", "en", "zh-CN") + (("new",) if o.get("new") else ())}
            for o in t["options"]]} for t in topics}
        catalog_ids = list(catalog)
        self.catalog_vectors = dict(zip(catalog_ids, embedding.embed(
            [catalog[cid]["en"] for cid in catalog_ids], embed_cfg))) if catalog_ids else {}
        # A topic is found by its question or by any claim already under it.
        self.vectors = {}
        for topic in self.topics.values():
            texts = [_topic_text(topic)] + [_claim_text(c) for c in topic["claims"]]
            self.vectors[topic["id"]] = embedding.embed(texts, embed_cfg)
        self.outcomes = []

    def _shortlist(self, vector, question_type):
        scores = {tid: max(embedding.similarity(vector, v) for v in vectors)
                  for tid, vectors in self.vectors.items()
                  if self.topics[tid]["question_type"] == question_type}
        ranked = sorted(scores.items(), key=lambda item: -item[1])[:TOPIC_SHORTLIST]
        return [(tid, score) for tid, score in ranked if score >= TOPIC_FLOOR]

    def place(self, claim, must_show=None):
        if any(claim["id"] == c["id"] for t in self.topics.values() for c in t["claims"]):
            return self._record(claim, "already_placed")
        vector = embedding.embed([_claim_text(claim)], self.embed_cfg)[0]
        shortlist = self._shortlist(vector, claim["question_type"])
        if must_show and must_show not in dict(shortlist):
            shortlist = [(must_show, 1.0)] + shortlist[:TOPIC_SHORTLIST - 1]
        prefix = "oaw:" + OBJECT_KINDS[claim["question_type"]] + ":"
        entries = embedding.nearest(vector, {cid: v for cid, v in self.catalog_vectors.items()
                                             if cid.startswith(prefix)}, CATALOG_SHORTLIST)
        user = "\n\n".join([
            "Claim:\n" + json.dumps({k: claim[k] for k in ("question_type", "object", "claim")}, ensure_ascii=False),
            "Open topics:\n" + ("\n".join(json.dumps({
                "id": tid, "object": self.topics[tid]["object"], "question": self.topics[tid]["question"]["en"],
                "options": [{"key": o["key"], "text": o["en"]} for o in self.topics[tid]["options"]],
            }, ensure_ascii=False) for tid, _ in shortlist) or "(none)"),
            "Catalog:\n" + "\n".join(f"{cid} | {self.catalog[cid]['en']}" for cid, _ in entries),
        ])
        result = _ask(PLACE_PROMPT, user, self.cfg)
        decision = result.get("decision") if isinstance(result, dict) else None
        shown = [{"topic": tid, "similarity": round(score, 3)} for tid, score in shortlist]
        if decision == "attach" and result.get("topic") in dict(shortlist):
            return self._attach(claim, vector, result, shown)
        if decision == "new":
            return self._open(claim, vector, result, {cid for cid, _ in entries}, shown, again=bool(must_show))
        if decision == "none":
            return self._record(claim, "left_out", reason=str(result.get("reason") or ""), shown=shown)
        return self._record(claim, "unplaced", shown=shown)

    def _attach(self, claim, vector, result, shown):
        topic = self.topics[result["topic"]]
        keys = {o["key"] for o in topic["options"]}
        option = str(result.get("option")) if str(result.get("option")) in keys else None
        added = _pair(result.get("new_option"))
        if option is None and added and len(topic["options"]) < MAX_OPTIONS:
            option = next(k for k in "abcdefgh" if k not in keys)
            topic["options"].append({"key": option, **added, "new": True})
        if option is None:
            return self._record(claim, "unplaced", shown=shown)
        topic["claims"].append({**claim, "option": option, "new": True})
        self.vectors[topic["id"]].append(vector)
        return self._record(claim, "attached", topic=topic["id"], option=option, shown=shown)

    def _open(self, claim, vector, result, offered, shown, again=False):
        question, obj = _pair(result.get("question")), _norm(result.get("object"))
        given = [(str(o.get("key")), _pair(o)) for o in result.get("options") or []
                 if isinstance(o, dict) and o.get("key") and _pair(o)]
        # Answers are keyed by their place - a, b, c - whatever the judge called them.
        renamed = {key: "abcdefgh"[index] for index, (key, _) in enumerate(given[:8])}
        options = [{"key": renamed[key], **pair, "new": True} for key, pair in given[:8]]
        took = renamed.get(str(result.get("claim_option")))
        if not (question and obj and took and len(renamed) == len(given[:8])):
            return self._record(claim, "unplaced", shown=shown)
        anchor = result.get("catalog_id") if result.get("catalog_id") in offered else None
        checks = result.get("checks") if isinstance(result.get("checks"), dict) else {}
        topic = {"id": topic_id(claim["question_type"], obj),
                 "question_type": claim["question_type"], "object": obj, "anchor": anchor,
                 "anchor_name": anchor and dict(self.catalog[anchor]),
                 "question": question, "options": options,
                 "queries": [str(q) for q in result.get("queries") or [] if q][:3],
                 "checks": {name: bool(checks.get(name)) for name in CHECKS},
                 "opened_on": claim["published_at"][:10], "opened_at": claim["published_at"],
                 "state": "proposed", "origin": "mined", "new": True,
                 "claims": [{**claim, "option": took, "new": True}]}
        if topic["id"] in self.topics:
            # The judge wrote a topic that is already open but was not among those it was shown.
            # It is asked once more with that topic in front of it; the same question is not opened twice.
            if again:
                return self._record(claim, "unplaced", shown=shown)
            return self.place(claim, must_show=topic["id"])
        self.topics[topic["id"]] = topic
        self.vectors[topic["id"]] = [embedding.embed([_topic_text(topic)], self.embed_cfg)[0], vector]
        return self._record(claim, "opened", topic=topic["id"], option=took, shown=shown)

    def _record(self, claim, outcome, **more):
        row = {"id": claim["id"], "handle": claim["handle"], "outcome": outcome, **more}
        self.outcomes.append(row)
        return row

    def described(self):
        order = {"open": 0, "one_sided": 1, "fails": 2}
        topics = [describe(t) for t in self.topics.values()]
        topics.sort(key=lambda t: (order[t["status"]], -t["accounts"], -t["views"]))
        return topics


REWORD_PROMPT = """You are given a topic - a closed question about one job or one kind of business - and its answers, each with the claims accounts made that were placed under it. Rewrite the answers; do not change what each one means.

""" + OPTION_STYLE + """

Keep the same keys and the same number of answers. Every claim listed under an answer must still be a claim for that answer after you rewrite it. The answers must still exclude each other. If an answer only repeats another one, or is about something other than the question, still return it, rewritten as closely as its meaning allows.

Return JSON: {"options": [{"key": the same key, "en": ..., "zh-CN": ...}]}. Write the Chinese as natural Simplified Chinese of about 6 to 14 characters, not a word-for-word translation."""


def reworded(topic, result):
    """The new wording for each answer, or None unless every answer came back short and in both languages."""
    found = {}
    for option in (result or {}).get("options") or []:
        pair = _pair(option) if isinstance(option, dict) else None
        if pair and len(pair["en"].split()) <= OPTION_MAX_WORDS + 2:
            found[str(option.get("key"))] = pair
    keys = [o["key"] for o in topic["options"]]
    return found if set(found) == set(keys) and len(found) == len(keys) else None


def reword(conn, cfg=None, reason="", progress=None):
    """Rewrite the stored answers that are longer than the standard allows; ids and places stay."""
    cfg = cfg or deepseek.config_from_env()
    counts = {"topics": 0, "topics_reworded": 0, "options_reworded": 0, "refused": 0}
    topics = [t for t in load_topics(conn)
              if any(len(o["en"].split()) > OPTION_MAX_WORDS for o in t["options"])]
    counts["topics"] = len(topics)
    for number, topic in enumerate(topics, 1):
        user = json.dumps({"question": topic["question"]["en"], "answers": [
            {"key": o["key"], "en": o["en"],
             "claims": [c["claim"] for c in topic["claims"] if c["option"] == o["key"]][:6]}
            for o in topic["options"]]}, ensure_ascii=False)
        new = reworded(topic, _ask(REWORD_PROMPT, user, cfg))
        if progress:
            progress(number, len(topics), "topic")
        if not new:
            counts["refused"] += 1
            continue
        with conn.transaction():
            for option in topic["options"]:
                pair = new[option["key"]]
                if (pair["en"], pair["zh-CN"]) == (option["en"], option["zh-CN"]):
                    continue
                oid = option_id(topic["id"], option["key"])
                conn.execute("INSERT INTO topic_option_revisions (option_id, text_en, text_zh_cn, reason) "
                             "VALUES (%s, %s, %s, %s)", (oid, option["en"], option["zh-CN"], reason))
                conn.execute("UPDATE topic_options SET text_en = %s, text_zh_cn = %s WHERE option_id = %s",
                             (pair["en"], pair["zh-CN"], oid))
                counts["options_reworded"] += 1
        counts["topics_reworded"] += 1
    return counts


def _iso(value):
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def load_topics(conn, fetch=None):
    """Open topics with their answers and the claims under them, in the shape the placer works on.

    `fetch(sql)` returns the rows of a query; the snapshot builder passes its own.
    """
    fetch = fetch or (lambda sql: conn.execute(sql).fetchall())
    topics = {}
    for row in fetch("""
        SELECT t.*, c.label_en AS anchor_en, c.label_zh_cn AS anchor_zh
        FROM topics t
        LEFT JOIN ontology_concepts c ON c.id = t.about_concept_id
             AND c.ontology_version = (SELECT max(ontology_version) FROM ontology_concepts)
        WHERE t.state NOT IN ('merged', 'closed') ORDER BY t.topic_id
    """):
        topics[row["topic_id"]] = {
            "id": row["topic_id"], "question_type": row["question_type"], "object": row["object_key"],
            "anchor": row["about_concept_id"],
            "anchor_name": row["about_concept_id"] and {"en": row["anchor_en"], "zh-CN": row["anchor_zh"]},
            "question": {"en": row["question_en"], "zh-CN": row["question_zh_cn"]},
            "state": row["state"], "origin": row["origin"], "checks": row["checks"],
            "opened_at": _iso(row["opened_at"]), "opened_on": _iso(row["opened_at"])[:10],
            "options": [], "claims": [], "queries": []}
    for row in fetch("SELECT * FROM topic_options WHERE NOT retired ORDER BY topic_id, position"):
        if row["topic_id"] in topics:
            topics[row["topic_id"]]["options"].append({
                "key": "abcdefgh"[row["position"] - 1], "en": row["text_en"], "zh-CN": row["text_zh_cn"]})
    for row in fetch("""
        SELECT k.topic_id, k.source_id, k.says, k.quote, o.position, s.account_handle, s.canonical_url, s.published_at,
               (SELECT (c.metrics->>'views')::bigint FROM collected_captures c
                 WHERE c.source_id = k.source_id ORDER BY c.captured_at DESC LIMIT 1) AS views
        FROM topic_claims k
        JOIN topic_options o ON o.option_id = k.option_id
        JOIN collected_sources s ON s.source_id = k.source_id
        ORDER BY s.published_at, k.source_id
    """):
        if row["topic_id"] in topics:
            topic = topics[row["topic_id"]]
            topic["claims"].append({
                "id": row["source_id"], "question_type": topic["question_type"], "object": topic["object"],
                "claim": row["says"], "quote": row["quote"], "handle": row["account_handle"],
                "url": row["canonical_url"], "published_at": _iso(row["published_at"]),
                "views": int(row["views"] or 0), "option": "abcdefgh"[row["position"] - 1]})
    for row in fetch("SELECT topic_id, query FROM topic_queries ORDER BY topic_id, query"):
        if row["topic_id"] in topics:
            topics[row["topic_id"]]["queries"].append(row["query"])
    return list(topics.values())


def store(conn, run_id, run, topics):
    """Write a run and what it added - new topics, new answers, new claims - in one transaction."""
    version = ontology_schema.load_schema()["version"]
    with conn.transaction():
        conn.execute("""
            INSERT INTO topic_mining_runs (run_id, version, model, embedding_model, window_start, window_end, counts, outcomes)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """, (run_id, run["version"], run["model"], run["embedding_model"], run["window"]["start"],
              run["window"]["end"], json.dumps(run["counts"]), json.dumps(run["outcomes"], ensure_ascii=False)))
        for topic in topics:
            if topic.get("new"):
                anchored = ("ai_proposed", "candidate") if topic["anchor"] else (None, None)
                conn.execute("""
                    INSERT INTO topics (topic_id, question_type, object_key, question_en, question_zh_cn, state, origin,
                                        about_concept_id, about_method, about_status, checks, opened_at,
                                        mining_run_id, schema_version)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (topic["id"], topic["question_type"], topic["object"], topic["question"]["en"],
                      topic["question"]["zh-CN"], topic["state"], topic["origin"], topic["anchor"], *anchored,
                      json.dumps(topic["checks"]), topic["opened_at"], run_id, version))
                for query in topic.get("queries", []):
                    conn.execute("INSERT INTO topic_queries (topic_id, query, mining_run_id) VALUES (%s, %s, %s) "
                                 "ON CONFLICT DO NOTHING", (topic["id"], query, run_id))
            for position, option in enumerate(topic["options"], 1):
                if option.get("new"):
                    conn.execute("INSERT INTO topic_options (option_id, topic_id, position, text_en, text_zh_cn) "
                                 "VALUES (%s, %s, %s, %s, %s)",
                                 (option_id(topic["id"], option["key"]), topic["id"], position, option["en"], option["zh-CN"]))
            for claim in topic["claims"]:
                if claim.get("new"):
                    conn.execute("INSERT INTO topic_claims (source_id, topic_id, option_id, says, quote, mining_run_id) "
                                 "VALUES (%s, %s, %s, %s, %s, %s)",
                                 (claim["id"], topic["id"], option_id(topic["id"], claim["option"]),
                                  claim["claim"], claim.get("quote"), run_id))


def votes_by_topic(votes_doc):
    """Readers' votes per topic in the running quarter, from a pulled votes file; empty without one."""
    if not votes_doc:
        return {}
    running, found = votes_doc.get("running_quarter"), {}
    for row in votes_doc.get("votes") or []:
        if row.get("quarter") == running:
            found[row["topic_id"]] = found.get(row["topic_id"], 0) + int(row["votes"])
    return found


def search_plan(conn, limit=20, per_topic=2, votes=None):
    """The phrases to search next: for the topics readers asked about and those most in need of another voice.

    Topics readers voted on this quarter come first, most votes first: a vote
    is a reader saying this question matters to them. Then one-sided topics -
    the side nobody argued is what a search is for - then by how long ago a
    topic was last searched, then by how much notice its claims drew. Each
    topic gives its first `per_topic` phrases. Votes choose what is researched;
    they never touch what is found.
    """
    asked = votes_by_topic(votes)
    searched = {row["topic_id"]: row["at"] for row in conn.execute(
        "SELECT topic_id, max(searched_at) AS at FROM topic_searches GROUP BY topic_id").fetchall()}
    topics = [describe(t) for t in load_topics(conn)]
    topics = [t for t in topics if t["status"] != "fails" and t["queries"]]
    topics.sort(key=lambda t: (-asked.get(t["id"], 0), t["status"] != "one_sided", t["id"] in searched,
                               str(searched.get(t["id"]) or ""), -t["views"]))
    return [{"topic": t["id"], "question": t["question"]["en"], "status": t["status"],
             "votes": asked.get(t["id"], 0), "query": query}
            for t in topics[:limit] for query in t["queries"][:per_topic]]


def record_searches(conn, run_doc, run_id):
    """Note which topics a search run was made for, from the phrases it searched."""
    wanted = {}
    for row in conn.execute("SELECT topic_id, query FROM topic_queries").fetchall():
        wanted.setdefault(row["query"], []).append(row["topic_id"])
    written = 0
    with conn.transaction():
        for job in run_doc.get("jobs") or []:
            # A search that was cut short did not look for the topic; it is searched again next time.
            if job.get("status") != "search_ended":
                continue
            for topic in wanted.get(job.get("search"), []):
                written += conn.execute("""
                    INSERT INTO topic_searches (collection_run_id, topic_id, query, posts_returned, stop_reason, searched_at)
                    VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING
                """, (run_id, topic, job["search"], len(job.get("posts") or []), job.get("stop_reason"),
                      run_doc["finished_at"])).rowcount
    return written


def mine(conn, window, run_id, claims=None, cfg=None, workers=4, limit=None, progress=None, keep=True,
         collection_runs=None):
    """Read the window and place its claims under the stored topics; returns (run document, topics)."""
    cfg = cfg or deepseek.config_from_env()
    counts = {}
    if claims is None:
        posts = load_posts(conn, window, collection_runs)
        if limit:
            posts = posts[:limit]
        claims, failed = read_claims(posts, cfg, workers=workers, progress=progress)
        counts.update(posts_read=len(posts), batches_failed=failed)
    before = load_topics(conn)
    placer = Placer(before, load_catalog(conn), cfg)
    for number, claim in enumerate(claims, 1):
        placer.place(claim)
        if progress:
            progress(number, len(claims), "claim")
    tally = {}
    for row in placer.outcomes:
        tally[row["outcome"]] = tally.get(row["outcome"], 0) + 1
    described = placer.described()
    counts.update(claims=len(claims), **{"claims_" + name: n for name, n in sorted(tally.items())},
                  topics=len(described), topics_before=len(before),
                  **{"topics_" + name: sum(1 for t in described if t["status"] == name)
                     for name in ("open", "one_sided", "fails")},
                  topics_anchored=sum(1 for t in described if t["anchor"]))
    run = {"version": VERSION, "model": cfg["model"], "embedding_model": embedding.config_from_env()["model"],
           "window": window, "counts": counts, "claims": claims, "outcomes": placer.outcomes}
    if keep:
        store(conn, run_id, run, list(placer.topics.values()))
    return run, described
