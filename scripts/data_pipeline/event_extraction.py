"""Extract deduplicated events from the collection store into the event layer.

This is the data-flow seam between the raw collection store (collected_sources /
collected_captures, produced by the crawler) and the independent event layer
(extracted_events and friends). The model call lives in `deepseek.py`; this module
is the deterministic spine around it:

  load_candidates ->  select_candidates  (pure: drop reposts/replies, dedup)
                  ->  [deepseek.extract_events]  (the only non-deterministic step)
                  ->  assemble_extraction  (pure: model output -> immutable doc)
                  ->  build_extraction_rows (pure: doc -> event-layer rows)
                  ->  ingest_extraction     (idempotent DB write)

No market scope, weights, metrics or progress live here; those belong to a later
calculation batch that projects FROM this layer. Social metrics are never copied:
provenance points back into the collection store through extracted_event_sources.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

from . import ontology_schema
from .pipeline import digest  # psycopg is imported lazily inside ingest_extraction

EXTRACTION_VERSION = "event-extraction-3"
# -3 adds the actor, the basis, facts, attachments and one outcome per post. A
# -2 document is still ingestible: it simply has none of them.
INGESTIBLE_VERSIONS = ("event-extraction-2", "event-extraction-3")
# The kinds come from the schema, which is also what migration 006 projects
# its CHECK from; a literal set here would be a second, silently diverging list.
EVENT_KINDS = frozenset(ontology_schema.term_ids("event_kind"))
# What a new extraction may classify into; a retired kind is only read, never written.
CURRENT_EVENT_KINDS = frozenset(ontology_schema.current_term_ids("event_kind"))
EVENT_KIND_VOCABULARY = ontology_schema.EVENT_KIND_VOCABULARY
OCCURRENCE = {"unknown", "scheduled", "occurred", "postponed", "cancelled"}
RELATION_KINDS = {"part_of", "follows", "supersedes", "refines", "duplicate_of"}
SOURCE_ROLES = {"primary", "corroborating", "context"}

# Organisations are ids, never free text (rule:org-must-be-id). The same company
# arrived under two spellings - 'xAI' on 9 events and 'xAI / SpaceXAI' on 14 - so
# every per-company aggregate was wrong and nothing said so. This table is both the
# alias index resolve_org uses and the seed for public.org_registry; a seeding
# script reads it as-is.
ROOT = Path(__file__).resolve().parents[2]


def _load_organizations():
    """The one organisation registry, read from datasets/ontology/data/organizations.json.

    There used to be two: this dict and the JSON file, hand-maintained in parallel.
    They had already diverged - each knew aliases the other did not - so an event
    naming an alias only the registry knew was silently dropped. That is precisely
    the failure rule:org-must-be-id exists to prevent, so there is now one file.
    """
    path = ROOT / "datasets/ontology/data/organizations.json"
    document = json.loads(path.read_text())
    return {
        org["org_id"]: {
            "canonical_name_en": org["name_en"],
            "canonical_name_zh_cn": org.get("name_zh_cn"),
            "aliases": list(org.get("aliases", [])),
        }
        for org in document["organizations"]
    }


ORGANIZATIONS = _load_organizations()


def _normalize_org(name):
    """Fold the spellings that differ only in punctuation or case into one key."""
    return " ".join(re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).split())


def _org_alias_index():
    index = {}
    for org_id, body in ORGANIZATIONS.items():
        for alias in [org_id, body["canonical_name_en"], body.get("canonical_name_zh_cn"),
                      *body.get("aliases", [])]:
            key = _normalize_org(alias)
            if not key:
                continue
            if index.get(key, org_id) != org_id:
                raise ValueError(f"Alias {alias!r} claimed by {index[key]} and {org_id}")
            index[key] = org_id
    return index


ORG_ALIASES = _org_alias_index()


def resolve_org(name):
    """Free-text organisation name -> org id, or None when it is not one we know.

    Never guesses. An unresolved name means the event is dropped and counted, which
    is recoverable (add the alias, re-extract); attaching it to the nearest-looking
    company would be a wrong aggregate that nobody notices.
    """
    return ORG_ALIASES.get(_normalize_org(name))


def _iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)


def _hashable(row):
    """A JSON-serializable view of a row for record hashing (datetimes -> ISO)."""
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in row.items()}


def _slug(text):
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug[:120] or None


def dedup_key(primary_org_id, kind, subject_key):
    """Identity of one real event: (org, kind, subject), never its wording.

    Identity used to be slug(org + title). A title is natural language, so one
    announcement written four ways became four events - "Qwen3.8-Max-0902 tops
    CodeArena WebDev" split into 4, "Apsara Conference 2026" into 4.
    """
    key = _slug(f"{primary_org_id or 'unknown'}|{kind or 'unresolved'}|{subject_key}")
    return key or ("event-" + digest([primary_org_id, kind, subject_key])[:24])


def title_dedup_key(primary_org_id, title):
    """Fallback identity when the model could not name the subject of the event."""
    return _slug(f"{primary_org_id or 'unknown'}-{title}") or ("event-" + digest(title or "")[:24])


OCCURRENCE_WINDOW_DAYS = 14


def event_times(occurred, scheduled, published):
    """(occurred_at, scheduled_for) with an announcement of something still to come kept in the past.

    A post cannot report what has not happened yet: a date later than the newest
    source post is the date the thing is planned for. It becomes `scheduled_for`
    (unless one was given) and the event is dated by that post, so nothing is
    placed in the future."""
    latest = max((p for p in published if p), default=None)
    if occurred and latest and occurred > latest:
        return latest, scheduled or occurred
    return occurred, scheduled


def occurrence_suffix(key, occurred_at, known_occurrences):
    """Separate a recurring event from its earlier occurrences.

    rule:event-identity-is-triple makes identity (org, kind, subject). An annual
    conference keeps all three year after year, so without this the 2027 Apsara
    Conference merges into the 2026 one and the newer date silently disappears.
    Two sightings more than a fortnight apart are two occurrences, and the later
    one takes the year - the same convention the extraction prompt states.

    `known_occurrences` maps dedup_key to the dates already recorded for it. The
    caller supplies it, so assembly stays a pure function of its inputs.
    """
    if not occurred_at or not known_occurrences:
        return ""
    seen = known_occurrences.get(key) or []
    if not seen:
        return ""
    window = timedelta(days=OCCURRENCE_WINDOW_DAYS)
    if any(abs(occurred_at - earlier) <= window for earlier in seen):
        return ""
    return f"-{occurred_at.year}"


def event_identity(primary_org_id, kind, subject_key, title):
    """(dedup_key, identity_confidence) for one event.

    With a subject and a kind the identity is the triple and confidence is high.
    Without a subject the title slug is all that is left, so the row carries 'low'
    and says why any later duplicate is not our miscount but a missing subject_key.

    An unresolved kind never merges: two events we could not classify are not
    thereby the same event, and collapsing them would hide the gap instead of
    counting it. Such a row keeps the triple shape but is disambiguated by its
    title and marked 'low', so a later rubric fix produces one event per real one.
    """
    if not subject_key:
        return title_dedup_key(primary_org_id, title), "low"
    if kind is None:
        key = dedup_key(primary_org_id, kind, subject_key)
        return f"{key}-{digest(title or '')[:12]}", "low"
    return dedup_key(primary_org_id, kind, subject_key), "high"


def _subject_key(value):
    """Canonical subject slug: 'Wan 3.0' and 'wan-3.0' are the same thing."""
    return _slug(value) if isinstance(value, str) else None


def _kind_of(raw):
    """(kind, unresolved_reason) for one model event.

    There is no "other" bucket any more (rule:no-other-bucket): 23.7% of events
    used to land in it, which hid the missing categories instead of counting them.
    An undecided kind is null plus a reason, and the reason is never empty - the
    extracted_events CHECK rejects a null kind without one.
    """
    value = raw.get("kind")
    kind = value.strip() if isinstance(value, str) else None
    if kind in CURRENT_EVENT_KINDS:
        return kind, None
    model_reason = raw.get("unresolved_reason")
    model_reason = model_reason.strip() if isinstance(model_reason, str) else ""
    if value is None or kind == "":
        return None, model_reason or "model returned no kind and no unresolved_reason"
    return None, f"model returned unknown kind {value!r}"


def event_id_for(key):
    """Deterministic event id from the dedup key (same event -> same id across runs)."""
    return "ev-" + digest(key)[:40]


# --- candidate selection (pure) -------------------------------------------------

def select_candidates(rows, window=None):
    """Filter joined source+capture rows down to extraction candidates.

    Drops reposts and replies (not original updates), keeps the latest capture per
    (platform, source_id), and optionally restricts to a [start, end) publish window.
    `rows` are dicts with source and capture fields already joined.
    """
    start = _iso(window["start"]) if window and window.get("start") else None
    end = _iso(window["end"]) if window and window.get("end") else None
    best = {}
    for row in rows:
        if row.get("is_repost") or row.get("is_reply"):
            continue
        published = _iso(row["published_at"])
        if start and published < start:
            continue
        if end and published >= end:
            continue
        key = (row.get("platform", "x"), row["source_id"])
        captured = _iso(row.get("captured_at"))
        current = best.get(key)
        if current is None or (captured and captured > current["_captured"]):
            best[key] = {
                "run_id": row["run_id"], "source_id": row["source_id"],
                "platform": row.get("platform", "x"), "handle": row.get("account_handle"),
                "company": row.get("company"), "url": row.get("canonical_url"),
                "published_at": published, "excerpt": row.get("public_excerpt") or "",
                # What the model reads. The excerpt stops at 280 characters, which
                # cut the numbers and conditions off every longer announcement.
                "text": row.get("full_text") or row.get("public_excerpt") or "",
                # Whose post it is. The actor of an update is the account that
                # posted it; only an official company account also names a company.
                # An author the panel does not have (found by search) has no row
                # yet; the key it would get is used, and the row is written only
                # if one of its posts makes an update (rule:search-finds-candidates).
                "account_key": row.get("account_key") or (
                    f"{row.get('platform', 'x')}:{row['account_handle'].lower()}"
                    if row.get("account_handle") and row.get("account_external_id") else None),
                "unregistered": (None if row.get("account_key") or not row.get("account_external_id") else
                                 {"handle": row["account_handle"],
                                  "platform_account_id": row["account_external_id"]}),
                "employer_org_id": row.get("employer_org_id"),
                "relay": row.get("panel_role") in RELAY_ROLES,
                "official": (row.get("panel_role") == "official" if "panel_role" in row
                             else bool(row.get("company"))),
                "metrics": row.get("metrics") or {}, "_captured": captured,
            }
    candidates = [{k: v for k, v in c.items() if k != "_captured"} for c in best.values()]
    candidates.sort(key=lambda c: (c["published_at"], c["source_id"]))
    return candidates


def load_known_occurrences(conn):
    """Dates already recorded against each event identity.

    Feeds assemble_extraction's occurrence window so a recurring event is not
    merged into its own earlier instance. Read here rather than inside assembly,
    which stays a pure function of what it is given.
    """
    with conn.cursor() as cursor:
        cursor.execute(
            """SELECT dedup_key, occurred_at FROM public.extracted_events
               WHERE occurred_at IS NOT NULL""")
        known = {}
        for row in cursor.fetchall():
            known.setdefault(row["dedup_key"], []).append(row["occurred_at"])
    return known


def load_known_events(conn, candidates, model=None):
    """Stored updates a candidate post may attach to (rule:post-outcome).

    Those of the days before the newest candidate, without the kinds the rule
    leaves out. An update whose own source posts are among the candidates is
    left out too: those posts are being read again and will state it themselves.
    """
    rule = ontology_schema.rule("rule:post-outcome", model)["expression"]
    if not candidates:
        return []
    newest = max(c["published_at"] for c in candidates)
    rows = conn.execute(
        """SELECT e.event_id, e.title, coalesce(e.occurred_at, e.announced_at) AS at,
                  e.subject_key, e.primary_org_id,
                  coalesce(o.canonical_name_en, a.handle, e.primary_org) AS by
             FROM public.extracted_events e
             LEFT JOIN public.org_registry o ON o.org_id = e.primary_org_id
             LEFT JOIN public.source_accounts a ON a.account_key = e.actor_account_key
            WHERE e.kind_vocabulary = ANY(%s)
              AND coalesce(e.occurred_at, e.announced_at) BETWEEN %s - make_interval(days => %s) AND %s
              AND (e.kind IS NULL OR e.kind <> ALL(%s))
              AND NOT EXISTS (SELECT 1 FROM public.extracted_event_sources s
                               WHERE s.event_id = e.event_id AND s.source_id = ANY(%s))
            ORDER BY 3, e.event_id""",
        (ontology_schema.EVENT_KIND_VOCABULARIES, newest, rule["known_events_within_days"], newest,
         rule["known_events_exclude_kinds"], [c["source_id"] for c in candidates])).fetchall()
    return [{"ref": f"E{number}", **row} for number, row in enumerate(rows, 1)]


def load_prior(conn, candidates):
    """Stored updates each candidate post was already a source of."""
    rows = conn.execute(
        """SELECT s.source_id, e.event_id, e.dedup_key
             FROM public.extracted_event_sources s
             JOIN public.extracted_events e ON e.event_id = s.event_id
            WHERE s.source_id = ANY(%s) AND e.kind_vocabulary = ANY(%s)""",
        ([c["source_id"] for c in candidates], ontology_schema.EVENT_KIND_VOCABULARIES)).fetchall()
    prior = {}
    for row in rows:
        known = {"event_id": row["event_id"], "dedup_key": row["dedup_key"]}
        if known not in prior.setdefault(row["source_id"], []):
            prior[row["source_id"]].append(known)
    return prior


TARGETS = {"official": "a.panel_role = 'official'", "panel": "a.panel_role <> 'official'",
           # Posts by authors the panel does not have, or has only as search candidates.
           "search": "(a.account_key IS NULL OR a.identity_grade = 'found_by_search')", "all": None}


def load_candidates(conn, window=None, collection_run_ids=None, limit=None, targets=None):
    """Read extraction candidates from the collection store (latest capture per post).

    `targets` narrows to official company accounts, to the panel, or to neither.
    """
    clauses = ["NOT s.is_repost", "NOT s.is_reply"]
    params = {"employee_relations": RELAY_RULE["employee_relations"]}
    if targets and TARGETS[targets]:
        clauses.append(TARGETS[targets])
    if collection_run_ids:
        clauses.append("s.run_id = ANY(%(runs)s)")
        params["runs"] = list(collection_run_ids)
    if window and window.get("start"):
        clauses.append("s.published_at >= %(start)s")
        params["start"] = _iso(window["start"])
    if window and window.get("end"):
        clauses.append("s.published_at < %(end)s")
        params["end"] = _iso(window["end"])
    sql = f"""
        SELECT s.run_id, s.source_id, s.platform, s.account_handle, s.account_external_id, s.company,
               s.canonical_url, s.is_reply, s.is_repost, s.published_at,
               c.captured_at, c.public_excerpt, c.full_text, c.metrics,
               a.account_key, a.panel_role,
               (SELECT f.org_id FROM person_affiliations f
                 WHERE f.person_id = a.person_id AND f.ended_on IS NULL AND f.org_id IS NOT NULL
                   AND f.relation = ANY(%(employee_relations)s)
                 ORDER BY f.started_on DESC NULLS LAST, f.affiliation_id LIMIT 1) AS employer_org_id
        FROM collected_sources s
        JOIN collected_captures c ON c.run_id = s.run_id AND c.source_id = s.source_id
        LEFT JOIN source_accounts a
               ON a.platform = s.platform AND a.platform_account_id = s.account_external_id
        WHERE {' AND '.join(clauses)}
        ORDER BY s.published_at
    """
    rows = conn.execute(sql, params).fetchall()
    candidates = select_candidates(rows, window)
    return candidates[:limit] if limit else candidates


# --- assembly (pure): model output + candidates -> immutable extraction doc -----

USE_KINDS = frozenset(ontology_schema.load_schema()["properties"]["Event.task"]["applies_to_kinds"])
BASES = frozenset(ontology_schema.term_ids("event_basis"))
RESULTS = frozenset(ontology_schema.term_ids("event_result"))


def _plain(text):
    return " ".join((text or "").split()).lower()


def quoted_in(quote, texts):
    """The source_id whose text contains the quote, ignoring case and spacing."""
    wanted = _plain(quote)
    if not wanted:
        return None
    for source_id, text in texts:
        if wanted in _plain(text):
            return source_id
    return None


def _text_or_none(value):
    value = value.strip() if isinstance(value, str) else None
    return value or None


def _facts(raw, texts):
    """Facts whose quoted words are really in one of the event's posts.

    A number the model cannot point to in the text is not stored: it is the one
    kind of error a reader cannot catch by looking at the page.
    """
    kept, refused = [], 0
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        value, what = item.get("value"), _text_or_none(item.get("what"))
        value = None if value is None else str(value).strip()
        source_id = quoted_in(item.get("quote"), texts)
        if not value or not what or not source_id:
            refused += 1
            continue
        fact = {"value": value, "unit": _text_or_none(item.get("unit")), "what": what,
                "quote": item["quote"].strip(), "source_id": source_id}
        if fact not in kept:
            kept.append(fact)
    return kept, refused


def prior_identity(source_ids, prior):
    """The stored update these posts were already the source of, if there is one.

    When a batch is extracted again, an update read from the same posts is the
    same update even if the model words its subject differently this time. The
    stored update sharing the most posts wins; a tie goes to the smaller id so
    the choice does not depend on row order.
    """
    shared = {}
    for source_id in source_ids:
        for known in (prior or {}).get(source_id, ()):
            shared.setdefault(known["event_id"], [0, known])[0] += 1
    if not shared:
        return None
    return min(shared.values(), key=lambda pair: (-pair[0], pair[1]["event_id"]))[1]


def _distinctive(subject_key):
    """Words of a subject that would not turn up by chance: long, or carrying a digit."""
    return {word for word in (subject_key or "").split("-")
            if len(word) >= 4 or any(ch.isdigit() for ch in word)}


def attachment_target(raw, cand, known_events):
    """The stored update an attachment points at, or the reason it is refused.

    The model picks a ref out of a list of several hundred and slips rows, so the
    ref alone is not believed: the title it copies back has to be that update's
    title, and when the copied title is another listed update's, the title wins.
    The post then has to use one of the update's own subject words, and a
    company's official account can only attach to that company's update. A
    refusal costs a detail; a wrong attachment puts one company's news under
    another's.
    """
    known = {ref: (entry if isinstance(entry, dict) else {"event_id": entry})
             for ref, entry in (known_events or {}).items()}
    by_title = {_plain(entry.get("title")): entry for entry in known.values() if entry.get("title")}
    echoed = _plain(raw.get("event_title"))
    target = by_title.get(echoed) if echoed else None
    if target is None:
        listed = known.get(str(raw.get("event_ref")))
        if listed is None or (listed.get("title") and echoed != _plain(listed["title"])):
            return None, "names_no_listed_update"
        target = listed
    words = _distinctive(target.get("subject_key"))
    text = _plain(cand.get("text") or cand.get("excerpt"))
    if words and not any(word in text for word in words):
        return None, "does_not_name_the_update"
    if cand.get("official") and target.get("primary_org_id") \
            and resolve_org(cand.get("company")) != target["primary_org_id"]:
        return None, "another_company_s_update"
    return target["event_id"], None


RELAY_RULE = ontology_schema.rule("rule:relays-are-not-a-source")["expression"]
RELAY_ROLES = frozenset(RELAY_RULE["relay_panel_roles"])


def _names_a_registered_company(*texts):
    words = " " + " ".join(_plain(text) for text in texts) + " "
    for body in ORGANIZATIONS.values():
        for name in [body["canonical_name_en"], *body["aliases"]]:
            if f" {_plain(name)} " in words.replace("-", " ").replace("'s ", " ").replace(":", " ").replace(",", " "):
                return True
    return False


def relay_reason(raw, author):
    """Why an update read from someone other than a company's own account is a relay.

    rule:relays-are-not-a-source, applied by the program because the model lets
    relays through: an account whose role is relay; a company's claim repeated
    by someone who works there; a registered company's claim about its own
    product repeated by anyone else. Someone's own use or measurement is never one.
    """
    if author.get("relay"):
        return "relay_account"
    if raw.get("basis") != "vendor_claim":
        return None
    if author.get("employer_org_id") in ORGANIZATIONS:
        return "relay_of_employer"
    if _names_a_registered_company(raw.get("subject"), raw.get("title")):
        return "relay_of_registered_company"
    return None


def assemble_extraction(candidates, batches, meta, known_occurrences=None, known_events=None, prior=None):
    """Turn per-batch model output into one immutable, deterministic extraction doc.

    `batches` is a list of {"events": [...]} objects (one per model call). Each model
    event references candidate posts by `source_ids` and may reference sibling events
    in the same batch by `relations: [{to_index, kind, ...}]`. Events are deduped
    across the whole doc by dedup_key, which is now the identity triple rather than
    the title; the first occurrence wins.

    Events that cannot be landed - no title, no collected source, no resolvable
    organisation - are dropped and counted in doc["dropped"], never repaired by
    guessing. doc["unresolved_orgs"] lists the names that need an alias.

    `known_occurrences` maps dedup_key to dates already recorded for that identity,
    so a recurring event more than a fortnight after its last sighting becomes a
    new occurrence rather than merging into the old one. Passing it in rather than
    querying keeps this function pure and testable.

    `known_events` maps the refs shown to the model ("E12") to stored event ids,
    for posts that attach to an update that already exists. `prior` maps a post
    to the stored updates it was a source of, so a batch extracted again lands
    on the same rows (rule:definitions-take-effect-forward).

    Every candidate post ends with one outcome in doc["post_outcomes"]: the
    source of a new update, attached to a known one, or dropped with the reason
    the model gave. A post the model never mentioned is "unaccounted".
    """
    by_source = {c["source_id"]: c for c in candidates}
    events, index = [], {}
    dropped, unresolved_orgs = {}, set()
    attachments, outcomes, reidentified, facts_refused = [], {}, 0, 0
    new_accounts = {}
    relays = {}

    def drop(reason):
        dropped[reason] = dropped.get(reason, 0) + 1

    for batch in batches:
        local = []
        for raw in batch.get("events", []):
            title = (raw.get("title") or "").strip()
            if not title:
                drop("no_title")
                continue
            sources = []
            for sid in raw.get("source_ids", []):
                cand = by_source.get(str(sid))
                if cand:
                    sources.append({"run_id": cand["run_id"], "source_id": cand["source_id"],
                                    "role": "primary"})
            if not sources:
                drop("no_known_source")  # every event must trace to a collected post
                continue
            if raw.get("kind") in EVENT_KINDS - CURRENT_EVENT_KINDS:
                drop("retired_kind")  # read on old rows, never written on a new one
                for src in sources:
                    outcomes.setdefault(src["source_id"], {"outcome": "drop", "reason": "retired kind: " + raw["kind"]})
                continue
            # A company's own post is the original even when someone at the
            # company also wrote about it: the official source decides who acted.
            authors = [by_source[src["source_id"]] for src in sources]
            author = next((a for a in authors if a.get("official")), authors[0])
            actor = author.get("account_key")
            if not author.get("official"):
                # What one person measured is theirs. The model merges posts
                # "about the same thing", which put five people's test results
                # under whoever came first; only that account's posts are kept,
                # and the others stay free to be read as their own updates.
                sources = [src for src in sources if by_source[src["source_id"]].get("account_key") == actor]
            if author.get("official"):
                org = (raw.get("primary_org") or "").strip() or None
                org_id = resolve_org(org)
                if org_id is None:
                    # An event is identified by its organisation, so a wrong one is a
                    # wrong per-company aggregate. Dropping it is recoverable: add the
                    # alias to ORGANIZATIONS and re-extract.
                    if org:
                        unresolved_orgs.add(org)
                        drop("unresolved_org")
                    else:
                        drop("missing_org")
                    continue
            else:
                # Not a company's own account: the update belongs to the account
                # that posted it. A company the post happens to name is its
                # subject, not its actor (rule:relays-are-not-a-source).
                org, org_id = None, None
                if not actor:
                    drop("no_actor")
                    continue
                relayed = relay_reason(raw, author)
                if relayed:
                    # Not an original: the company's own post is. The post is
                    # attached to that update below, as one more account saying so.
                    drop(relayed)
                    for src in sources:
                        relays.setdefault(src["source_id"], {
                            "reason": "relay: " + relayed, "title": (raw.get("title") or "").strip(),
                            "subject_key": _subject_key(raw.get("subject_key"))})
                    continue
                if raw.get("kind") not in CURRENT_EVENT_KINDS:
                    # A company's post that fits no kind is kept and counted. Anyone
                    # else's is a post about nothing in particular, which is a drop.
                    drop("no_kind_from_a_non_official_account")
                    for src in sources:
                        outcomes.setdefault(src["source_id"], {
                            "outcome": "drop",
                            "reason": _text_or_none(raw.get("unresolved_reason")) or "no update stated"})
                    continue
            kind, unresolved_reason = _kind_of(raw)
            subject_key = _subject_key(raw.get("subject_key"))
            key, identity_confidence = event_identity(org_id or actor, kind, subject_key, title)
            occurred, scheduled = event_times(
                _iso(raw.get("occurred_at")), _iso(raw.get("scheduled_for")),
                [by_source[src["source_id"]]["published_at"] for src in sources])
            key += occurrence_suffix(key, occurred, known_occurrences)
            eid = event_id_for(key)
            stored = prior_identity([src["source_id"] for src in sources], prior)
            if stored and stored["event_id"] != eid:
                eid, key = stored["event_id"], stored["dedup_key"]
                reidentified += 1
            status = raw.get("occurrence_status") if raw.get("occurrence_status") in OCCURRENCE else "occurred"
            texts = [(src["source_id"], by_source[src["source_id"]].get("text")
                      or by_source[src["source_id"]].get("excerpt")) for src in sources]
            facts, refused = _facts(raw.get("facts"), texts)
            facts_refused += refused
            uses = kind in USE_KINDS
            task = _text_or_none(raw.get("task")) if uses else None
            result = raw.get("result") if uses and raw.get("result") in RESULTS else None
            quote = _text_or_none(raw.get("quote"))
            if author.get("unregistered"):
                new_accounts[actor] = author["unregistered"]
            event = {
                "event_id": eid, "dedup_key": key, "kind": kind,
                "kind_vocabulary": EVENT_KIND_VOCABULARY, "unresolved_reason": unresolved_reason,
                "subject_key": subject_key, "identity_confidence": identity_confidence,
                "title": title,
                "summary": (raw.get("summary") or title).strip(),
                "primary_org": org, "primary_org_id": org_id,
                "announced_at": _iso(raw.get("announced_at")).isoformat() if raw.get("announced_at") else None,
                "occurred_at": occurred.isoformat() if occurred else None,
                "scheduled_for": scheduled.isoformat() if scheduled else None,
                "occurrence_status": status,
                "confidence": _confidence(raw.get("confidence")),
                "actor_account_key": actor,
                "subject": _text_or_none(raw.get("subject")),
                "basis": raw.get("basis") if raw.get("basis") in BASES else None,
                "task": task,
                "result": result or ("not_stated" if task else None),
                "quote": quote if quote and quoted_in(quote, texts) else None,
                "schema_version": ontology_schema.SCHEMA_VERSION,
                "facts": facts,
                "sources": sources, "categories": _categories(raw.get("categories")),
                "relations": [], "_raw_relations": raw.get("relations", []),
            }
            local.append(event)
            for src in sources:
                outcomes[src["source_id"]] = {"outcome": "new_event", "event_id": eid}
            if key not in index:
                index[key] = event
                events.append(event)
            else:
                _merge_sources(index[key], event["sources"])
                for fact in event["facts"]:
                    if fact not in index[key]["facts"]:
                        index[key]["facts"].append(fact)
                for cat in event["categories"]:
                    if cat not in index[key]["categories"]:
                        index[key]["categories"].append(cat)
        # resolve within-batch relations by local index -> dedup_key
        for pos, event in enumerate(local):
            for rel in event.pop("_raw_relations", []):
                target = _relation_target(rel, local, pos)
                if target and rel.get("kind") in RELATION_KINDS and target["dedup_key"] != event["dedup_key"]:
                    index[event["dedup_key"]]["relations"].append({
                        "to_event_id": target["event_id"], "kind": rel["kind"],
                        "rationale": (rel.get("rationale") or "").strip() or "model-proposed",
                        "confidence": _confidence(rel.get("confidence"))})
    for event in events:
        event.pop("_raw_relations", None)

    for batch in batches:
        for raw in batch.get("attachments") or []:
            cand = by_source.get(str(raw.get("source_id")))
            says = _text_or_none(raw.get("says"))
            if not cand or not says:
                drop("attachment_without_post_or_content")
                continue
            if cand["source_id"] in outcomes:  # the source of a new update is not also a comment on another
                continue
            target, refused = attachment_target(raw, cand, known_events)
            if refused:
                drop("attachment_" + refused)
                outcomes[cand["source_id"]] = {"outcome": "drop", "reason": "attachment refused: " + refused}
                continue
            quote = _text_or_none(raw.get("quote"))
            text = [(cand["source_id"], cand.get("text") or cand.get("excerpt"))]
            attachments.append({"event_id": target, "source_id": cand["source_id"], "says": says,
                                "quote": quote if quote and quoted_in(quote, text) else None})
            outcomes[cand["source_id"]] = {"outcome": "attach", "event_id": target}
        for raw in batch.get("dropped") or []:
            source_id = str(raw.get("source_id"))
            if source_id in by_source and source_id not in outcomes:
                outcomes[source_id] = {"outcome": "drop",
                                       "reason": _text_or_none(raw.get("reason")) or "no reason given"}
    # A relay of an update we hold is one more account saying so. Matched on
    # the subject both name: first a company's update from this same run, then
    # a stored one. No match, no attachment - the relay is simply dropped.
    by_subject = {}
    for entry in (known_events or {}).values():
        if isinstance(entry, dict) and entry.get("subject_key") and entry.get("primary_org_id"):
            by_subject[entry["subject_key"]] = entry["event_id"]
    for event in events:
        if event["subject_key"] and event["primary_org_id"]:
            by_subject[event["subject_key"]] = event["event_id"]
    for source_id, relay in relays.items():
        if source_id in outcomes:
            continue
        target = by_subject.get(relay["subject_key"])
        if target:
            attachments.append({"event_id": target, "source_id": source_id,
                                "says": relay["title"] or "Repeats the update.", "quote": None})
            outcomes[source_id] = {"outcome": "attach", "event_id": target}
        else:
            outcomes[source_id] = {"outcome": "drop", "reason": relay["reason"]}
    for source_id in by_source:
        outcomes.setdefault(source_id, {"outcome": "unaccounted"})

    doc = {
        "version": EXTRACTION_VERSION, "model": meta["model"],
        "prompt_sha256": meta["prompt_sha256"], "params": meta.get("params", {}),
        # Which rubric produced these classifications; a boundary edited in the
        # semantic layer changes this hash, so two runs are comparable or visibly not.
        "schema_version": ontology_schema.SCHEMA_VERSION,
        "rubric_sha256": ontology_schema.rubric_sha256(),
        "kind_vocabulary": EVENT_KIND_VOCABULARY,
        "collection_run_ids": sorted({c["run_id"] for c in candidates}),
        "window": meta.get("window"), "started_at": meta["started_at"],
        "finished_at": meta.get("finished_at"), "status": meta.get("status", "completed"),
        "candidate_count": len(candidates), "events": events,
        "attachments": attachments, "post_outcomes": outcomes,
        # Authors found by search whose post made an update, to record as candidates.
        "new_accounts": {key: new_accounts[key] for key in sorted(new_accounts)
                         if any(event["actor_account_key"] == key for event in events)},
        "dropped": dropped, "unresolved_orgs": sorted(unresolved_orgs),
        "reidentified": reidentified, "facts_refused": facts_refused,
        # What the model returned, batch by batch, so the program's rules can be
        # applied again without asking it again.
        "model_output": batches,
    }
    return doc


def _confidence(value):
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, num))


def _categories(items):
    out = []
    for item in items or []:
        cid = str(item.get("category_id") or "").strip()
        taxonomy = item.get("taxonomy")
        version = str(item.get("taxonomy_version") or "").strip()
        if not cid or taxonomy not in ("ontology", "platform") or not version:
            continue
        out.append({"taxonomy": taxonomy, "taxonomy_version": version, "category_id": cid,
                    "confidence": _confidence(item.get("confidence")),
                    "rationale": (item.get("rationale") or "").strip() or "model-proposed"})
    return out


def _merge_sources(event, new_sources):
    seen = {(s["run_id"], s["source_id"], s["role"]) for s in event["sources"]}
    for src in new_sources:
        key = (src["run_id"], src["source_id"], src["role"])
        if key not in seen:
            seen.add(key)
            event["sources"].append(src)


def _relation_target(rel, local, pos):
    idx = rel.get("to_index")
    if isinstance(idx, int) and 0 <= idx < len(local) and idx != pos:
        return local[idx]
    return None


# --- row building (pure): extraction doc -> event-layer DB rows -----------------

def _check_ingestible(row):
    """Fail here, naming the event, rather than at the CHECK constraint.

    Both conditions are impossible for a doc this module assembled; a hand-edited
    or foreign document is what this catches.
    """
    if row["kind_vocabulary"] not in ontology_schema.EVENT_KIND_VOCABULARIES:
        return  # a legacy-vocabulary row keeps its old values untouched
    if row["kind"] is None and not (row["unresolved_reason"] or "").strip():
        raise ValueError(f"Event {row['event_id']} has no kind and no unresolved_reason")
    if row["kind"] is not None and row["kind"] not in EVENT_KINDS:
        raise ValueError(f"Event {row['event_id']} has kind {row['kind']!r}, not a controlled term")
    if row["kind_vocabulary"] == EVENT_KIND_VOCABULARY:
        if not row["actor_account_key"]:
            raise ValueError(f"Event {row['event_id']} has no actor_account_key")
    elif not row["primary_org_id"]:
        raise ValueError(f"Event {row['event_id']} has no primary_org_id")


EVENT_DETAIL = ("actor_account_key", "subject", "basis", "task", "result", "quote", "schema_version")


def build_detail_rows(doc, run_id):
    """Pure: the facts and attachments of an extraction document."""
    facts, seen = [], set()
    for ev in doc.get("events", []):
        for fact in ev.get("facts") or []:
            fact_id = "fact-" + digest([ev["event_id"], fact["source_id"], fact["what"], fact["value"]])[:40]
            if fact_id in seen:
                continue
            seen.add(fact_id)
            facts.append({"fact_id": fact_id, "event_id": ev["event_id"], "source_id": fact["source_id"],
                          "value": fact["value"], "unit": fact.get("unit"), "what": fact["what"],
                          "quote": fact["quote"], "extraction_run_id": run_id})
    attachments = [{**item, "extraction_run_id": run_id} for item in doc.get("attachments") or []]
    return facts, attachments


def build_extraction_rows(doc, run_id):
    """Pure: turn an extraction document into event-layer rows. No I/O."""
    if not isinstance(doc, dict) or doc.get("version") not in INGESTIBLE_VERSIONS:
        raise ValueError("Not an event-extraction document")
    if doc.get("status") not in ("completed", "failed") or "events" not in doc:
        raise ValueError("Only a finished extraction can be ingested")

    run = {
        "run_id": run_id,
        "collection_run_ids": doc.get("collection_run_ids", []),
        "model": doc["model"], "prompt_sha256": doc["prompt_sha256"],
        "params": doc.get("params", {}),
        "window_start": _iso(doc["window"]["start"]) if doc.get("window") and doc["window"].get("start") else None,
        "window_end": _iso(doc["window"]["end"]) if doc.get("window") and doc["window"].get("end") else None,
        "started_at": _iso(doc["started_at"]),
        "finished_at": _iso(doc["finished_at"]) if doc.get("finished_at") else None,
        "status": doc["status"], "candidate_count": doc.get("candidate_count"),
        "event_count": len(doc["events"]), "run_sha256": digest(doc),
    }

    events, sources, relations, categories = [], [], [], []
    seen_events, seen_source, seen_rel, seen_cat = set(), set(), set(), set()
    for ev in doc["events"]:
        eid = ev["event_id"]
        if eid not in seen_events:
            seen_events.add(eid)
            row = {
                "event_id": eid, "dedup_key": ev["dedup_key"], "kind": ev["kind"],
                "kind_vocabulary": ev.get("kind_vocabulary") or doc.get("kind_vocabulary") or EVENT_KIND_VOCABULARY,
                "unresolved_reason": ev.get("unresolved_reason"),
                "subject_key": ev.get("subject_key"),
                "identity_confidence": ev.get("identity_confidence"),
                "title": ev["title"], "summary": ev["summary"],
                "primary_org": ev.get("primary_org"), "primary_org_id": ev.get("primary_org_id"),
                "announced_at": _iso(ev.get("announced_at")), "occurred_at": _iso(ev.get("occurred_at")),
                "scheduled_for": _iso(ev.get("scheduled_for")), "occurrence_status": ev["occurrence_status"],
                "first_extraction_run_id": run_id, "confidence": ev.get("confidence"),
            }
            detail = {name: ev.get(name) for name in EVENT_DETAIL}
            _check_ingestible({**row, **detail})
            # Hashed only when present, so a document from before these
            # attributes existed keeps the record hash it always had.
            row["record_sha256"] = digest(_hashable({**row, **detail} if any(detail.values()) else row))
            row.update(detail)
            events.append(row)
        for src in ev.get("sources", []):
            role = src.get("role", "primary")
            role = role if role in SOURCE_ROLES else "primary"
            pk = (eid, src["run_id"], src["source_id"], role)
            if pk in seen_source:
                continue
            seen_source.add(pk)
            sources.append({"event_id": eid, "run_id": src["run_id"],
                            "source_id": src["source_id"], "source_role": role})
        for rel in ev.get("relations", []):
            pk = (eid, rel["to_event_id"], rel["kind"])
            if pk in seen_rel or rel["to_event_id"] == eid:
                continue
            seen_rel.add(pk)
            relations.append({"from_event_id": eid, "to_event_id": rel["to_event_id"],
                              "kind": rel["kind"], "rationale": rel["rationale"],
                              "confidence": rel.get("confidence"), "extraction_run_id": run_id})
        for cat in ev.get("categories", []):
            pk = (eid, cat["taxonomy"], cat["taxonomy_version"], cat["category_id"])
            if pk in seen_cat:
                continue
            seen_cat.add(pk)
            categories.append({"event_id": eid, "taxonomy": cat["taxonomy"],
                               "taxonomy_version": cat["taxonomy_version"], "category_id": cat["category_id"],
                               "method": "ai_deepseek", "confidence": cat.get("confidence"),
                               "rationale": cat["rationale"], "extraction_run_id": run_id})
    return run, events, sources, relations, categories


def ingest_extraction(conn, extraction_path):
    """Idempotently ingest one extraction document into the event layer.

    Re-ingesting the same run (same run_id and identical content) is a no-op; the
    same run_id with different content is rejected. Events already present from an
    earlier run (same event_id) are kept, and only new provenance links are added.
    """
    from psycopg.types.json import Jsonb

    extraction_path = Path(extraction_path)
    doc = json.loads(extraction_path.read_text())
    run_id = extraction_path.stem
    run, events, sources, relations, categories = build_extraction_rows(doc, run_id)
    facts, attachments = build_detail_rows(doc, run_id)

    candidate = ontology_schema.rule("rule:search-finds-candidates")["expression"]
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(7543005)")
        for key, account in (doc.get("new_accounts") or {}).items():
            row = {"account_key": key, "handle": account["handle"],
                   "platform_account_id": account["platform_account_id"], **candidate,
                   "added_from": f"search:{run_id}"}
            conn.execute(
                """INSERT INTO source_accounts
                   (account_key, platform, handle, platform_account_id, owner_kind, panel_role, panel_state,
                    identity_grade, added_from, state_changed_at, record_sha256)
                   VALUES (%(account_key)s, 'x', %(handle)s, %(platform_account_id)s, %(owner_kind)s,
                    %(panel_role)s, %(panel_state)s, %(identity_grade)s, %(added_from)s, now(), %(sha)s)
                   ON CONFLICT DO NOTHING""", {**row, "sha": digest(row)})
        old = conn.execute("SELECT run_sha256 FROM extraction_runs WHERE run_id=%s", (run_id,)).fetchone()
        if old:
            if old["run_sha256"] != run["run_sha256"]:
                raise ValueError(f"Extraction run {run_id} already ingested with different content")
            return {"run_id": run_id, "reused": True, "events": run["event_count"],
                    "sources": len(sources), "relations": len(relations), "categories": len(categories)}
        conn.execute(
            """INSERT INTO extraction_runs
               (run_id,collection_run_ids,model,prompt_sha256,params,window_start,window_end,
                started_at,finished_at,status,run_sha256,candidate_count,event_count)
               VALUES (%(run_id)s,%(collection_run_ids)s,%(model)s,%(prompt_sha256)s,%(params)s,
                %(window_start)s,%(window_end)s,%(started_at)s,%(finished_at)s,%(status)s,
                %(run_sha256)s,%(candidate_count)s,%(event_count)s)""",
            {**run, "collection_run_ids": Jsonb(run["collection_run_ids"]), "params": Jsonb(run["params"])})
        for e in events:
            conn.execute(
                """INSERT INTO extracted_events
                   (event_id,dedup_key,kind,kind_vocabulary,unresolved_reason,subject_key,
                    identity_confidence,title,summary,primary_org,primary_org_id,announced_at,
                    occurred_at,scheduled_for,occurrence_status,first_extraction_run_id,
                    confidence,record_sha256,actor_account_key,subject,basis,task,result,quote,
                    schema_version)
                   VALUES (%(event_id)s,%(dedup_key)s,%(kind)s,%(kind_vocabulary)s,
                    %(unresolved_reason)s,%(subject_key)s,%(identity_confidence)s,%(title)s,
                    %(summary)s,%(primary_org)s,%(primary_org_id)s,%(announced_at)s,
                    %(occurred_at)s,%(scheduled_for)s,%(occurrence_status)s,
                    %(first_extraction_run_id)s,%(confidence)s,%(record_sha256)s,
                    %(actor_account_key)s,%(subject)s,%(basis)s,%(task)s,%(result)s,%(quote)s,
                    %(schema_version)s)
                   -- An update extracted before these attributes existed is upgraded
                   -- when its posts are read again: it gains them and the version it
                   -- was read under. Its title, summary and dates stay as they were,
                   -- and its earlier content is still in the archive of that run.
                   ON CONFLICT (event_id) DO UPDATE SET
                    kind = EXCLUDED.kind, kind_vocabulary = EXCLUDED.kind_vocabulary,
                    unresolved_reason = EXCLUDED.unresolved_reason,
                    actor_account_key = EXCLUDED.actor_account_key, subject = EXCLUDED.subject,
                    basis = EXCLUDED.basis, task = EXCLUDED.task, result = EXCLUDED.result,
                    quote = EXCLUDED.quote, schema_version = EXCLUDED.schema_version,
                    record_sha256 = EXCLUDED.record_sha256
                   WHERE extracted_events.schema_version IS NULL
                     AND EXCLUDED.schema_version IS NOT NULL""", e)
        for s in sources:
            conn.execute(
                """INSERT INTO extracted_event_sources (event_id,run_id,source_id,source_role)
                   VALUES (%(event_id)s,%(run_id)s,%(source_id)s,%(source_role)s)
                   ON CONFLICT DO NOTHING""", s)
        for r in relations:
            conn.execute(
                """INSERT INTO extracted_event_relations
                   (from_event_id,to_event_id,kind,rationale,confidence,extraction_run_id)
                   VALUES (%(from_event_id)s,%(to_event_id)s,%(kind)s,%(rationale)s,%(confidence)s,%(extraction_run_id)s)
                   ON CONFLICT DO NOTHING""", r)
        for f in facts:
            conn.execute(
                """INSERT INTO extracted_event_facts
                   (fact_id,event_id,source_id,value,unit,what,quote,extraction_run_id)
                   VALUES (%(fact_id)s,%(event_id)s,%(source_id)s,%(value)s,%(unit)s,%(what)s,
                    %(quote)s,%(extraction_run_id)s)
                   ON CONFLICT DO NOTHING""", f)
        for a in attachments:
            conn.execute(
                """INSERT INTO extracted_event_attachments (event_id,source_id,says,quote,extraction_run_id)
                   VALUES (%(event_id)s,%(source_id)s,%(says)s,%(quote)s,%(extraction_run_id)s)
                   ON CONFLICT DO NOTHING""", a)
        for c in categories:
            conn.execute(
                """INSERT INTO extracted_event_categories
                   (event_id,taxonomy,taxonomy_version,category_id,method,confidence,rationale,extraction_run_id)
                   VALUES (%(event_id)s,%(taxonomy)s,%(taxonomy_version)s,%(category_id)s,%(method)s,
                    %(confidence)s,%(rationale)s,%(extraction_run_id)s)
                   ON CONFLICT DO NOTHING""", c)
    return {"run_id": run_id, "reused": False, "events": run["event_count"],
            "sources": len(sources), "relations": len(relations), "categories": len(categories),
            "facts": len(facts), "attachments": len(attachments)}
