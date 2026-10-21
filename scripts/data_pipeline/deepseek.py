"""DeepSeek extraction call — the one non-deterministic step of event extraction.

DeepSeek exposes an OpenAI-compatible chat/completions endpoint, so this stays a
thin stdlib HTTP client (no new dependency). The API key is infrastructure and
lives in the environment (DEEPSEEK_API_KEY), never in the pool file, the skill, a
committed file or NEXT_PUBLIC. Model and endpoint are overridable via
DEEPSEEK_MODEL / DEEPSEEK_BASE_URL. The prompt is versioned by its SHA-256 so a
prompt change is visible in every extraction run's provenance.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import ontology_schema
from .pipeline import digest


class DeepSeekError(RuntimeError):
    """A recoverable model-call error: one batch may be retried, then skipped."""

DEFAULT_MODEL = "deepseek-chat"
DEFAULT_BASE_URL = "https://api.deepseek.com"

# -3: the model is given the whole post instead of the 280-character excerpt.
# -4: three outcomes per post, the basis, facts and attachments (schema 2.2.0).
# -5: a third party's measurement of a market is an update (event_kind 2.2.0).
EXTRACTION_VERSION_TAG = "deepseek-events-5"


def system_prompt(official=False):
    """The extraction prompt, built from the schema instead of hand-typed.

    There are two: one for posts by companies' official accounts and one for
    everyone else. A relay is something only the second group can post. Given one
    prompt for both, the model called a company's own post about its customer, or
    about its product reaching a partner's platform, a relay and dropped it.

    Everything that decides a classification - the event kinds, their boundaries,
    the identity rule, the bases and results - is rendered from
    datasets/ontology/schema/schema.json. A boundary changes in one place, and
    `prompt_sha256` moves when it does. The list of known updates a run attaches
    posts to is data, not part of the prompt: `known_events_message` renders it.
    """
    schema = ontology_schema.load_schema()
    use_kinds = ", ".join(schema["properties"]["Event.task"]["applies_to_kinds"])
    rules = {rule["id"]: rule for rule in schema["constraints"]}

    def choices(name):
        terms = schema["vocabularies"][name]["terms"]
        return [f"- {term_id}: {body['definition']['en']}" for term_id, body in terms.items()]

    if official:
        who = ("You read posts from the OFFICIAL accounts of AI companies, and extract structured "
               "records of real UPDATES: something that actually happened.")
        third = ("- in `dropped`, with a short reason: a post that states nothing concrete - a bare link, "
                 "a slogan, a giveaway, a greeting, a hiring ad - and any announcement or recap of a "
                 "conference, livestream, contest, hackathon, workshop or talk.")
        about_authors = [
            "Every post here is a company speaking about its own products, so each one is an original, "
            "never a relay. When a post names a concrete function, product, version, price, availability "
            "or result of the company's own product, it IS an event - even when the wording is "
            "promotional, even when the feature may have shipped earlier, and even when the news is that "
            "a named customer uses the product or that it is now available on a partner's platform.",
            "The actor of an event is the account that posted it, and is filled in by the program.",
        ]
    else:
        who = ("You read posts about AI from individual people and from organisations that are not the "
               "maker of the thing they write about, and extract structured records of real UPDATES: "
               "something that actually happened.")
        third = ("- in `dropped`, with a short reason: everything else - opinion, joke, life advice, travel, "
                 "politics, self-promotion with no content, a bare link, a talk or podcast plug, a reaction "
                 "with no substance, and any announcement or recap of a conference, contest, hackathon or "
                 "workshop. Most posts by individuals are dropped. Do not stretch. A post with no update "
                 "goes in `dropped`, never in `events` with a null kind.")
        about_authors = [
            "Relays: " + rules["rule:relays-are-not-a-source"]["statement"]["en"],
            "A relay is never an event. When what it passes on is in the known-updates list, attach it "
            "to that update; otherwise drop it with a reason starting with \"relay:\".",
            "The actor of an event is always the account that posted it, and is filled in by the program "
            "- do not try to name one.",
            "A third party's own measurement of how AI is taken up or what it does to work - how many "
            "people or companies use or pay for AI, what they spend on it, how AI products rank by use, "
            "what happened to hiring or employment in a named occupation or industry as AI spread - is a "
            "market_measurement when the post gives at least one number and says what it counts. A "
            "statistic that has nothing to do with AI (total payrolls, share prices, religion, an "
            "election) is dropped. It is not opinion, and it is not dropped for naming no "
            "product: its subject is the report, survey or dataset the number comes from, and its "
            "subject_key is that source plus what is measured. A link to a report with no number in "
            "the post is dropped.",
            "NEVER merge posts by different authors into one event. Two people who each tested the same "
            "model have made two events, one each, with their own numbers. Merge only several posts by "
            "the SAME author about the same thing.",
        ]
    return "\n".join([
        who,
        "",
        "Every post you are given ends in exactly one of three places:",
        "- in the `source_ids` of an entry of `events`: the post itself states an update that is "
        "not in the known-updates list. Merge every post describing the SAME update into ONE event.",
        "- in `attachments`: the post is ABOUT one update in the known-updates list - it repeats "
        "it, adds a detail, or reports a use or test of it. An attachment only records that this "
        "account said so.",
        third,
        "",
        *about_authors,
        "",
        ontology_schema.event_kind_rubric(),
        "",
        "A person or small team shipping their OWN product or tool is a product_launch, "
        "version_release or capability_update - but only when the post names at least one concrete "
        "function the thing now has, or gives a number. A bare \"v1.3 is out\", a teaser or a link "
        "is dropped.",
        "",
        ontology_schema.event_identity_rule(),
        "",
        "Classification rules:",
        "- `kind` MUST be one of the controlled terms above, spelled exactly. There is no "
        "\"other\" bucket and inventing one (\"other\", \"misc\", \"announcement\", a term of your "
        "own) is an error.",
        "- If you cannot decide between terms, or none of them fits, set `kind` to null and "
        "write a short `unresolved_reason` saying what you were stuck on. `unresolved_reason` "
        "must be non-empty whenever `kind` is null, and is ignored when `kind` is set. A null "
        "with a reason is useful; a wrong term is not.",
        "- Give `subject_key` for EVERY event: the canonical name of the thing being "
        "announced, evaluated, used or adopted (product line plus version, benchmark plus track, "
        "event plus year), lowercase, punctuation and spaces replaced by hyphens. Leave it "
        "empty only when the posts genuinely name no subject.",
        "- For an event from a company's official account give `primary_org`: the company behind "
        "the update, written as one plain company name (\"xAI\", never \"xAI / SpaceXAI\"; "
        "\"Zhipu\", \"Moonshot\", \"Google\", \"Alibaba\"). Such an event whose company cannot "
        "be named is dropped. For any other author leave `primary_org` null.",
        "- Merge by identity, not by wording: two posts by the same author about the same "
        "(kind, subject_key) are ONE event however differently they are titled.",
        "",
        "`basis` - on what basis the update is known, judged by who produced the evidence in the post:",
        *choices("event_basis"),
        "",
        f"`task` and `result` are given ONLY for these kinds: {use_kinds}. For every other kind "
        "both are null.",
        "- `task`: ONE plain sentence saying what concrete piece of work the AI was given, "
        "understandable to a non-engineer.",
        "- `result`:",
        *choices("event_result"),
        "",
        "Return STRICT JSON, an object: {\"events\": [...], \"attachments\": [...], \"dropped\": [...]}.",
        "Each event:",
        '- "kind": one of the controlled terms above, or null',
        '- "unresolved_reason": short reason, required when "kind" is null, otherwise omitted',
        '- "subject_key": canonical name of the subject (see above), or null',
        '- "subject": the product or model exactly as the post names it, or null',
        '- "title": short factual title (<=120 chars), no marketing language; display only',
        '- "summary": one or two factual sentences',
        '- "primary_org": the company behind the update, for official company accounts only',
        '- "basis": one of the terms above',
        '- "task", "result": see above',
        '- "quote": the sentence of the post that states the update, copied EXACTLY',
        '- "facts": array of {"value", "unit", "what", "quote"} - every number, price, limit, score, '
        'date or scope the posts give; "value" as written, "unit" or null, "what" it measures, '
        '"quote" copied EXACTLY from the post. A fact whose quote is not in the post is discarded.',
        '- "occurred_at": ISO 8601 UTC timestamp of when it happened, or null',
        '- "occurrence_status": one of unknown, scheduled, occurred, postponed, cancelled',
        '- "confidence": number 0..1, your confidence this is a genuine distinct update',
        '- "source_ids": array of the given post ids that state this event (at least one)',
        '- "relations": optional array of {"to_index": <index of another event in THIS batch>, '
        '"kind": one of part_of, follows, supersedes, refines, duplicate_of, "rationale": short reason}',
        'Each attachment: {"source_id": a given post id, "event_ref": a ref from the known-updates '
        'list, "event_title": the title of that update copied EXACTLY from the list, "says": one '
        'sentence of what the post adds, "quote": exact words from the post}. An attachment whose '
        'title does not match, or whose post never names the update\'s subject, is discarded.',
        'Each dropped entry: {"source_id": a given post id, "reason": short}.',
        "",
        "Rules: use only the given posts as evidence; never invent a number, a name or a result. "
        "Every given post id appears exactly once across the three lists. Output ONLY the JSON object.",
    ])


def known_events_message(known):
    """The updates a post may attach to, as the model sees them."""
    if not known:
        return "Known updates: none."
    lines = ["Known updates (ref | date | company or account | title):"]
    for item in known:
        when = item["at"].date().isoformat() if hasattr(item["at"], "date") else str(item["at"])[:10]
        lines.append(f"{item['ref']} | {when} | {item.get('by') or ''} | {item['title']}")
    return "\n".join(lines)


def prompt_sha256():
    """Version anchor for the extraction prompt (recorded on every run).

    Hashes the rubric alongside the prompt text: the rendered rubric is already
    inside the prompt, but a separate rubric hash keeps a schema edit
    legible in provenance instead of hidden inside one opaque digest.
    """
    return digest({"system": system_prompt(), "system_official": system_prompt(official=True),
                   "schema": EXTRACTION_VERSION_TAG,
                   "rubric_sha256": ontology_schema.rubric_sha256(),
                   "semantic_version": ontology_schema.EVENT_KIND_VERSION})


def load_env(root):
    """Populate os.environ from local .env without overriding real env."""
    path = Path(root) / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def config_from_env():
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise RuntimeError("DeepSeek is not configured. Set DEEPSEEK_API_KEY in .env")
    return {
        "api_key": key,
        "model": os.environ.get("DEEPSEEK_MODEL", "").strip() or DEFAULT_MODEL,
        "base_url": (os.environ.get("DEEPSEEK_BASE_URL", "").strip() or DEFAULT_BASE_URL).rstrip("/"),
    }


def _post_message(candidates):
    """Compact, id-tagged rendering of one batch of candidate posts."""
    lines = ["Posts:"]
    for c in candidates:
        published = c["published_at"]
        when = published.isoformat() if hasattr(published, "isoformat") else str(published)
        lines.append(json.dumps({
            "id": c["source_id"], "org": c.get("company") or c.get("handle"),
            "author": "@" + str(c.get("handle") or ""),
            "author_type": "company_official" if c.get("official") else "person_or_other_organisation",
            "published_at": when,
            "text": c.get("text") or c.get("excerpt", ""),
        }, ensure_ascii=False))
    return "\n".join(lines)


def chat(messages, cfg, timeout=120):
    """One OpenAI-compatible chat/completions call in JSON mode; returns parsed content.

    Raises DeepSeekError on any transport, HTTP, empty-response or malformed-JSON
    problem so the caller can retry that one batch and, failing that, skip it.
    """
    payload = json.dumps({
        "model": cfg["model"], "messages": messages,
        "response_format": {"type": "json_object"}, "temperature": 0, "stream": False,
    }).encode()
    request = urllib.request.Request(
        f"{cfg['base_url']}/chat/completions", data=payload, method="POST",
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        raise DeepSeekError(f"HTTP {error.code}: {error.read().decode()[:200]}") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise DeepSeekError(f"request failed: {error}") from None
    if isinstance(body, dict) and body.get("error"):
        raise DeepSeekError(f"api error: {str(body['error'])[:200]}")
    choices = (body or {}).get("choices") or []
    if not choices:
        raise DeepSeekError(f"no choices: {json.dumps(body)[:200]}")
    content = (choices[0].get("message") or {}).get("content")
    if not content:
        raise DeepSeekError("empty content")
    try:
        return json.loads(content)
    except ValueError:
        raise DeepSeekError("model did not return valid JSON") from None


def extract_events(candidates, cfg=None, batch_size=25, progress=None, max_attempts=3,
                   known=None, workers=1):
    """Extract events from candidates in batches. Returns (batches, failures).

    Each batch is retried up to `max_attempts` on a DeepSeekError with backoff; a batch
    that still fails is recorded in `failures` and skipped (empty), so one bad call does
    not lose the whole run. Output is deterministic-shaped ({"events": [...]}) so
    `assemble_extraction` can turn it into an immutable document.

    `known` is the list of stored updates a post may attach to. `workers` runs
    that many batches at once; the result keeps batch order either way.
    """
    cfg = cfg or config_from_env()
    prompts = {True: system_prompt(official=True), False: system_prompt()}
    known_message = known_events_message(known)
    # Official accounts and everyone else are read in separate batches, each
    # under its own prompt; the order of posts inside a group is kept.
    chunks = []
    for official in (True, False):
        group = [c for c in candidates if bool(c.get("official")) == official]
        chunks += [group[index:index + batch_size] for index in range(0, len(group), batch_size)]
    total = len(chunks)

    def one(numbered):
        number, chunk = numbered
        messages = [{"role": "system", "content": prompts[bool(chunk[0].get("official"))]},
                    {"role": "user", "content": known_message + "\n\n" + _post_message(chunk)}]
        result, error = None, None
        for attempt in range(max_attempts):
            try:
                result = chat(messages, cfg)
                break
            except DeepSeekError as exc:
                error = exc
                time.sleep(2 * (attempt + 1))
        if result is None:
            if progress:
                progress(number, total, 0)
            return {"events": []}, {"batch": number, "error": str(error)}
        result = result if isinstance(result, dict) else {}
        batch = {name: result.get(name) if isinstance(result.get(name), list) else []
                 for name in ("events", "attachments", "dropped")}
        if progress:
            progress(number, total, len(batch["events"]))
        return batch, None

    numbered = list(enumerate(chunks, 1))
    if workers > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(workers) as pool:
            done = list(pool.map(one, numbered))
    else:
        done = [one(item) for item in numbered]
    batches = [batch for batch, _ in done]
    failures = [failure for _, failure in done if failure]
    return batches, failures
