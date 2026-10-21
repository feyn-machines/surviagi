"""The evidence panel: which accounts' posts count, and as what.

Nothing here is decided by hand. An account's state comes from the checks
logged against it (rule:panel-lifecycle), and whether a post of its is
independent of a company from its affiliations on the day of the post
(rule:panel-independence). Accounts are not sorted into uses: what a post
counts as is decided by the post itself (rule:verification-tier). A curator
edits the facts - an affiliation, a check, an exclusion - and the state
follows; there is no field to set "enabled" directly.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timezone

from . import ontology_schema

STATES_THAT_WERE_LIVE = {"enabled", "suspended"}


def _lifecycle(model=None):
    return ontology_schema.rule("rule:panel-lifecycle", model)["expression"]


def breaks_independence(relation, model=None):
    return bool(ontology_schema.term("affiliation_relation", relation, model)["breaks_independence"])


def _as_date(value):
    if value is None or isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    return date.fromisoformat(str(value)[:10])


def is_independent(affiliations, org_id, on, model=None, owner_org_id=None):
    """Whether an account's post on `on` is independent of `org_id`.

    Per company and per date: joining OpenAI in July does not reach back and
    make a June post about OpenAI a vendor claim, and leaving Meta ends it.
    An organisation's own account is never independent of that organisation
    (rule:panel-independence, owner_organization_breaks).
    """
    if owner_org_id is not None and owner_org_id == org_id and \
            ontology_schema.rule("rule:panel-independence", model)["expression"].get("owner_organization_breaks"):
        return False
    on = _as_date(on)
    for aff in affiliations:
        if aff.get("org_id") != org_id or not breaks_independence(aff["relation"], model):
            continue
        start, end = _as_date(aff.get("started_on")), _as_date(aff.get("ended_on"))
        if (start is None or start <= on) and (end is None or end >= on):
            return False
    return True


def _latest(checks, kind):
    rows = [c for c in checks if c["check_kind"] == kind]
    return max(rows, key=lambda c: c["checked_at"]) if rows else None


def _grade_rank(grade, model=None):
    return ontology_schema.term("identity_evidence_grade", grade, model)["rank"]


def derive_state(account, checks, now, model=None):
    """The state the checks support. Pure: same facts, same state."""
    rule = _lifecycle(model)
    was_live = account.get("panel_state") in STATES_THAT_WERE_LIVE

    ids = sorted((c for c in checks if c["check_kind"] == "platform_id"), key=lambda c: c["checked_at"])
    failed_run = 0
    for c in reversed(ids):
        if c["outcome"] != "fail":
            break
        failed_run += 1
    if failed_run >= rule["retire_after_failed_rechecks"]:
        return "retired"

    latest_id = ids[-1] if ids else None
    identity = (account.get("platform_account_id") is not None
                and _grade_rank(account["identity_grade"], model) >= _grade_rank(rule["identity_min_grade"], model)
                and (latest_id is None or latest_id["outcome"] == "pass"))
    if not identity:
        return "suspended" if was_live and latest_id is not None else "candidate"

    blocked = bool(account.get("excluded"))
    if account.get("owner_kind") == "person":
        aff = _latest(checks, "affiliation")
        if aff is None or aff["outcome"] != "pass" or \
                (now - aff["checked_at"]).days > rule["affiliation_recheck_days"]:
            blocked = True
    activity = _latest(checks, "activity")
    last_post = (activity or {}).get("detail", {}).get("last_post_at")
    if last_post:
        quiet = (now - datetime.fromisoformat(last_post)).days
        if quiet > rule["dormant_after_days"]:
            blocked = True

    if not blocked:
        return "enabled"
    return "suspended" if was_live else "identity_confirmed"


def resolve_org(name, registry):
    """The tracked vendor an organisation name refers to, by whole-word alias."""
    for org in registry:
        for alias in sorted(org["aliases"], key=len, reverse=True):
            if re.search(rf"(?<![\w]){re.escape(alias)}(?![\w])", name or "", re.IGNORECASE):
                return org["org_id"]
    return None


_DEPARTED = re.compile(r"\b(former|formerly|left|ex-|departed|previously)\b", re.IGNORECASE)


def relation_of(affiliation, model=None):
    """A draft affiliation's relation in the controlled vocabulary, or None.

    Research passes wrote departures into the organisation text ("Meta (left,
    announced 2025-11)"); those become `former` rather than a current tie.
    """
    relation = affiliation.get("relation")
    if relation not in ontology_schema.term_ids("affiliation_relation", model):
        return None
    if _DEPARTED.search(affiliation.get("org") or ""):
        return "former"
    return relation


def _sha(value):
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def org_key(name):
    """An organisation name without its parenthetical notes, for de-duplication."""
    return re.sub(r"\s*\(.*?\)", "", name or "").strip().lower()


def account_key(platform, handle):
    return f"{platform}:{handle.lower().lstrip('@')}"


def person_id_for(entry):
    """One person, however many accounts: keyed by normalised name, not handle.

    Keyed by handle, Dan Hendrycks became two people (@DanHendrycks and
    @hendrycks), each with its own affiliations - so a change recorded against
    one would not reach the other. Names are not unique in general; within a
    curated panel a collision is rare enough to surface by hand.
    """
    name = re.sub(r"\s+", " ", entry["name"]).strip().lower()
    return "person:" + hashlib.sha256(name.encode("utf-8")).hexdigest()[:16]


_person_id = person_id_for


def import_draft(conn, doc, source_name):
    """Load a research draft. Idempotent: facts are keyed, checks are content-addressed.

    Re-importing the same draft changes nothing; a later draft with a moved
    affiliation adds a row and a check rather than rewriting history.
    """
    registry = conn.execute("SELECT org_id, aliases FROM public.org_registry").fetchall()
    observed_on = doc["as_of"]
    checked_at = datetime.fromisoformat(observed_on).replace(tzinfo=timezone.utc)
    counts = {"accounts": 0, "affiliations": 0, "checks": 0}
    for entry in doc["accounts"]:
        handle = entry["handle"].lstrip("@")
        key = account_key("x", handle)
        person_id = None
        if entry["account_kind"] == "person":
            person_id = _person_id(entry)
            row = {"person_id": person_id, "name": entry["name"], "identity_url": entry.get("identity_evidence_url")}
            conn.execute(
                """INSERT INTO public.people (person_id, name, identity_url, record_sha256)
                   VALUES (%(person_id)s, %(name)s, %(identity_url)s, %(sha)s)
                   ON CONFLICT (person_id) DO NOTHING""", {**row, "sha": _sha(row)})
            for aff in entry.get("affiliations") or []:
                relation = relation_of(aff)
                if relation is None or not aff.get("org"):
                    continue
                fact = {"person_id": person_id, "org_name": aff["org"], "relation": relation,
                        "org_id": resolve_org(aff["org"], registry), "observed_on": observed_on,
                        "source_url": aff.get("source_url")}
                conn.execute(
                    """INSERT INTO public.person_affiliations
                         (affiliation_id, person_id, org_name, org_id, relation, observed_on, source_url, record_sha256)
                       VALUES (%(id)s, %(person_id)s, %(org_name)s, %(org_id)s, %(relation)s,
                               %(observed_on)s, %(source_url)s, %(sha)s)
                       ON CONFLICT (affiliation_id) DO NOTHING""",
                    {**fact, "id": "aff:" + _sha([person_id, org_key(aff["org"]), relation])[:24], "sha": _sha(fact)})
                counts["affiliations"] += 1
        org_name = entry["name"] if entry["account_kind"] == "organization" else None
        row = {"account_key": key, "handle": handle,
               "owner_kind": "person" if person_id else "organization", "person_id": person_id,
               "org_name": org_name, "org_id": resolve_org(org_name, registry) if org_name else None,
               "panel_role": entry["primary_role"], "excluded": entry["use"] == "exclude",
               "identity_grade": entry["identity_evidence_kind"], "identity_url": entry.get("identity_evidence_url"),
               "language": entry.get("language"), "focus": entry.get("focus"), "added_from": source_name}
        conn.execute(
            """INSERT INTO public.source_accounts
                 (account_key, platform, handle, owner_kind, person_id, org_name, org_id, panel_role, excluded,
                  panel_state, identity_grade, identity_url, language, focus, added_from, state_changed_at, record_sha256)
               VALUES (%(account_key)s, 'x', %(handle)s, %(owner_kind)s, %(person_id)s, %(org_name)s, %(org_id)s,
                       %(panel_role)s, %(excluded)s, 'candidate', %(identity_grade)s, %(identity_url)s,
                       %(language)s, %(focus)s, %(added_from)s, %(at)s, %(sha)s)
               ON CONFLICT (account_key) DO NOTHING""", {**row, "at": checked_at, "sha": _sha(row)})
        counts["accounts"] += 1
        checks = [("identity", "pass", {"grade": entry["identity_evidence_kind"]}, entry.get("identity_evidence_url"))]
        if person_id:
            known = any(relation_of(a) for a in entry.get("affiliations") or [])
            checks.append(("affiliation", "pass" if known else "unknown", {"from": source_name}, None))
        for kind, outcome, detail, url in checks:
            body = {"account_key": key, "check_kind": kind, "outcome": outcome, "detail": detail,
                    "checked_at": observed_on, "method": "imported"}
            conn.execute(
                """INSERT INTO public.source_account_checks
                     (check_id, account_key, check_kind, checked_at, outcome, method, detail, source_url, record_sha256)
                   VALUES (%(id)s, %(account_key)s, %(check_kind)s, %(at)s, %(outcome)s, 'imported',
                           %(detail)s::jsonb, %(url)s, %(sha)s)
                   ON CONFLICT (check_id) DO NOTHING""",
                {**body, "id": "chk:" + _sha(body)[:24], "at": checked_at, "url": url,
                 "detail": json.dumps(detail), "sha": _sha(body)})
            counts["checks"] += 1
    return counts


def refresh(conn, now=None):
    """Re-derive every account's state from its checks; write only changes."""
    now = now or datetime.now(timezone.utc)
    accounts = conn.execute("SELECT * FROM public.source_accounts").fetchall()
    checks = {}
    for c in conn.execute("SELECT account_key, check_kind, outcome, checked_at, detail FROM public.source_account_checks"):
        checks.setdefault(c["account_key"], []).append(c)
    changed = {}
    for a in accounts:
        own = checks.get(a["account_key"], [])
        state = derive_state(a, own, now)
        if state != a["panel_state"]:
            conn.execute(
                """UPDATE public.source_accounts SET panel_state = %s, state_changed_at = %s
                    WHERE account_key = %s""", (state, now, a["account_key"]))
            changed[a["account_key"]] = (a["panel_state"], state)
    return changed


def probe_findings(doc, handles):
    """What a collector account-monitor run says about each requested handle.

    Only the account's own posts count: a search can return others quoting it.
    Two different ids under one handle is recorded as a conflict and resolves
    nothing - picking one would be guessing which account is the person.
    """
    requests = doc.get("requests")
    if requests is not None:
        # Only handles the collector actually asked about can be reported on;
        # it stops at its own account limit, and unasked is not the same as quiet.
        asked = {m.group(1).lower() for r in requests if r.get("http_status") in (None, 200)
                 for m in [re.search(r"from:(\w+)", r.get("query") or "")] if m}
        handles = [h for h in handles if h.lower() in asked]
    by_handle = {h.lower(): [] for h in handles}
    for post in doc.get("posts") or []:
        author = (post.get("author") or "").lower()
        if author in by_handle and post.get("author_id"):
            by_handle[author].append(post)
    found = {}
    for handle in handles:
        posts = by_handle[handle.lower()]
        ids = sorted({str(p["author_id"]) for p in posts})
        if not posts:
            found[handle] = {"platform_account_id": None, "last_post_at": None,
                             "no_posts_in_hours": doc.get("hours")}
        elif len(ids) > 1:
            found[handle] = {"platform_account_id": None, "last_post_at": None, "conflict": ids}
        else:
            latest = max(p["created_utc"] for p in posts)
            found[handle] = {"platform_account_id": ids[0],
                             "last_post_at": datetime.fromtimestamp(latest, timezone.utc).isoformat()}
    return found


def _add_check(conn, key, kind, outcome, checked_at, method, detail, url=None):
    body = {"account_key": key, "check_kind": kind, "outcome": outcome, "detail": detail,
            "checked_at": checked_at.isoformat(), "method": method}
    conn.execute(
        """INSERT INTO public.source_account_checks
             (check_id, account_key, check_kind, checked_at, outcome, method, detail, source_url, record_sha256)
           VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
           ON CONFLICT (check_id) DO NOTHING""",
        ("chk:" + _sha(body)[:24], key, kind, checked_at, outcome, method, json.dumps(detail), url, _sha(body)))


def record_probe(conn, doc, handles, checked_at=None):
    """Write a probe's findings as checks, and fill a platform id the first time it is seen."""
    checked_at = checked_at or datetime.fromisoformat(doc["fetched_at"])
    found = probe_findings(doc, handles)
    summary = {"resolved": 0, "changed": 0, "quiet": 0, "conflict": 0}
    for handle, f in found.items():
        key = account_key("x", handle)
        row = conn.execute("SELECT platform_account_id FROM public.source_accounts WHERE account_key = %s",
                           (key,)).fetchone()
        if row is None:
            continue
        if f.get("conflict"):
            _add_check(conn, key, "platform_id", "fail", checked_at, "collector", {"conflict": f["conflict"]})
            summary["conflict"] += 1
            continue
        if f["platform_account_id"] is None:
            _add_check(conn, key, "activity", "unknown", checked_at, "collector",
                       {"no_posts_in_hours": f.get("no_posts_in_hours")})
            summary["quiet"] += 1
            continue
        known = row["platform_account_id"]
        if known is not None and known != f["platform_account_id"]:
            _add_check(conn, key, "platform_id", "changed", checked_at, "collector",
                       {"was": known, "now": f["platform_account_id"]})
            summary["changed"] += 1
            continue
        if known is None:
            conn.execute("UPDATE public.source_accounts SET platform_account_id = %s WHERE account_key = %s",
                         (f["platform_account_id"], key))
        _add_check(conn, key, "platform_id", "pass", checked_at, "collector",
                   {"platform_account_id": f["platform_account_id"]})
        _add_check(conn, key, "activity", "pass", checked_at, "collector", {"last_post_at": f["last_post_at"]})
        summary["resolved"] += 1
    return summary


TARGETS_SQL = """
    SELECT a.handle, a.platform_account_id, a.panel_role, a.org_name, p.name AS person_name
      FROM public.source_accounts a
      LEFT JOIN public.people p ON p.person_id = a.person_id
     WHERE a.platform = 'x' AND a.panel_state = 'enabled' AND NOT a.excluded
       AND a.platform_account_id IS NOT NULL
       AND (%(roles)s::text[] IS NULL OR a.panel_role = ANY(%(roles)s))
       AND NOT (a.panel_role = ANY(%(skip)s::text[]))
     ORDER BY a.handle
"""

TARGET_SETS = ("official", "panel", "all")


def registry_rows(rows):
    """Enabled accounts in the shape the crawler plans timeline jobs from.

    One user-timeline job per enabled account with a numeric X user id. For an
    official account `company` is the organisation name exactly as the official
    registry wrote it, which event extraction reads back from collected sources.
    """
    out = []
    for r in rows:
        if not r.get("platform_account_id"):
            continue
        out.append({"company": r.get("org_name") or r.get("person_name") or r["handle"],
                    "handle": r["handle"], "x_user_id": str(r["platform_account_id"]),
                    "account_type": "official" if r["panel_role"] == "official" else "panel",
                    "panel_role": r["panel_role"],
                    "enabled": True, "verification_status": "confirmed"})
    return out


def crawl_targets(conn, targets="official"):
    """Enabled accounts the crawler collects: `official`, `panel` (everyone else) or `all`.

    Official and panel accounts are collected in separate runs by default, so a
    run's posts stay one kind of source.
    """
    if targets not in TARGET_SETS:
        raise ValueError(f"targets must be one of {', '.join(TARGET_SETS)}")
    params = {"roles": ["official"] if targets == "official" else None,
              "skip": ["official"] if targets == "panel" else []}
    return registry_rows(conn.execute(TARGETS_SQL, params).fetchall())


def official_grade(evidence):
    """The identity grade an official registry entry's evidence supports.

    A link from the organisation's own site, repository or navigation is
    first-party; X's organisation affiliation badge is the account's own
    profile saying who it is; anything else is only a list.
    """
    methods = {e.get("method") or "" for e in evidence or []}
    if any(m.startswith("official_") for m in methods):
        return "first_party_link"
    if "x_organization_affiliation" in methods:
        return "official_bio"
    return "third_party_list"


def official_records(registry, orgs, source_name, as_of):
    """Pure: official registry entries -> [(account row, [(kind, outcome, detail, url, checked_at)])].

    Only an enabled, confirmed entry with a numeric user id gets identity and
    platform-id checks; anything else is recorded as a candidate, so its state
    stays what the registry says - not yet collectable.
    """
    records = []
    for entry in registry:
        handle = entry["handle"].lstrip("@")
        org_id = resolve_org(entry["company"], orgs)
        if org_id is None:
            raise ValueError(f"@{handle}: company {entry['company']!r} is not a tracked organisation")
        evidence = entry.get("identity_evidence") or []
        confirmed = (entry.get("enabled") is True and entry.get("verification_status") == "confirmed"
                     and str(entry.get("x_user_id") or "").isdigit())
        row = {"account_key": account_key("x", handle), "handle": handle,
               "platform_account_id": str(entry["x_user_id"]) if confirmed else None,
               "org_name": entry["company"], "org_id": org_id,
               "identity_grade": official_grade(evidence) if confirmed else "third_party_list",
               "identity_url": (evidence[0].get("url") if evidence else None) or entry.get("profile_url"),
               "focus": entry.get("scope"), "added_from": source_name}
        checks = []
        if confirmed:
            at = entry.get("profile_checked_at") or as_of
            checks = [("identity", "pass", {"grade": row["identity_grade"], "from": source_name},
                       row["identity_url"], at),
                      ("platform_id", "pass", {"platform_account_id": row["platform_account_id"]},
                       entry.get("profile_url"), at)]
        records.append((row, checks))
    return records


def import_official(conn, registry, source_name, as_of=None):
    """Load the official registry into source_accounts. Idempotent.

    An official row is refreshed from the registry (a later confirmation fills
    its user id); a handle already on the panel under another role is refused
    rather than silently re-labelled.
    """
    as_of = as_of or datetime.now(timezone.utc).isoformat()
    orgs = conn.execute("SELECT org_id, aliases FROM public.org_registry").fetchall()
    counts = {"accounts": 0, "confirmed": 0, "checks": 0}
    for row, checks in official_records(registry, orgs, source_name, as_of):
        existing = conn.execute("SELECT panel_role FROM public.source_accounts WHERE account_key = %s",
                                (row["account_key"],)).fetchone()
        if existing and existing["panel_role"] != "official":
            raise ValueError(f"@{row['handle']} is already a {existing['panel_role']} panel account")
        conn.execute(
            """INSERT INTO public.source_accounts
                 (account_key, platform, handle, platform_account_id, owner_kind, org_name, org_id,
                  panel_role, excluded, panel_state, identity_grade, identity_url, focus, added_from,
                  state_changed_at, record_sha256)
               VALUES (%(account_key)s, 'x', %(handle)s, %(platform_account_id)s, 'organization', %(org_name)s,
                       %(org_id)s, 'official', false, 'candidate', %(identity_grade)s, %(identity_url)s,
                       %(focus)s, %(added_from)s, now(), %(sha)s)
               ON CONFLICT (account_key) DO UPDATE SET
                   platform_account_id = coalesce(public.source_accounts.platform_account_id,
                                                  EXCLUDED.platform_account_id),
                   org_name = EXCLUDED.org_name, org_id = EXCLUDED.org_id,
                   identity_grade = EXCLUDED.identity_grade, identity_url = EXCLUDED.identity_url,
                   focus = EXCLUDED.focus, record_sha256 = EXCLUDED.record_sha256""",
            {**row, "sha": _sha(row)})
        counts["accounts"] += 1
        counts["confirmed"] += bool(checks)
        for kind, outcome, detail, url, at in checks:
            _add_check(conn, row["account_key"], kind, outcome, datetime.fromisoformat(at),
                       "imported", detail, url)
            counts["checks"] += 1
    return counts


PROFILE_FIELDS = ("name", "description", "followers", "following", "posts", "verified", "protected")


def lookup_checks(known_id, previous_profile, record):
    """What one lookup record says, as (new_id, [(kind, outcome, detail)]).

    Pure. `unresolved` says nothing: failing to ask is not an answer. A bio that
    differs from the last profile sends the affiliation back for review, which
    suspends an enabled account until someone re-confirms where they work.
    """
    status = record.get("status")
    if status == "unresolved":
        return None, []
    if status in ("not_found", "unavailable"):
        return None, [("platform_id", "fail", {"status": status, "reason": record.get("reason")})]
    user_id = record["user_id"]
    if known_id is not None and known_id != user_id:
        return None, [("platform_id", "changed", {"was": known_id, "now": user_id})]
    profile = {f: record.get(f) for f in PROFILE_FIELDS}
    checks = [("platform_id", "pass", {"platform_account_id": user_id}), ("profile", "pass", profile)]
    if previous_profile is not None and \
            (previous_profile.get("description") or "") != (profile.get("description") or ""):
        checks.append(("affiliation", "unknown",
                       {"reason": "bio changed", "was": previous_profile.get("description"),
                        "now": profile.get("description")}))
    return (user_id if known_id is None else None), checks


def lookup_plan(conn, missing_only=True):
    """Handles to look up: those with no platform id, or every non-excluded account."""
    where = "AND platform_account_id IS NULL" if missing_only else ""
    return [r["handle"] for r in conn.execute(
        f"""SELECT handle FROM public.source_accounts
             WHERE platform = 'x' AND NOT excluded AND panel_state <> 'retired' {where}
             ORDER BY handle""").fetchall()]


def record_lookup(conn, doc):
    """Write a crawler lookup run's results as checks; returns counts by outcome."""
    at = datetime.fromisoformat(doc["finished_at"])
    counts = {}
    for handle, record in doc["results"].items():
        key = account_key("x", handle)
        row = conn.execute("SELECT platform_account_id FROM public.source_accounts WHERE account_key = %s",
                           (key,)).fetchone()
        if row is None:
            continue
        previous = conn.execute(
            """SELECT detail FROM public.source_account_checks
                WHERE account_key = %s AND check_kind = 'profile'
                ORDER BY checked_at DESC LIMIT 1""", (key,)).fetchone()
        new_id, checks = lookup_checks(row["platform_account_id"], previous and previous["detail"], record)
        if new_id:
            conn.execute("UPDATE public.source_accounts SET platform_account_id = %s WHERE account_key = %s",
                         (new_id, key))
        if record.get("status") == "found" and (record.get("avatar_url") or "").startswith("https://") \
                and row["platform_account_id"] in (None, record.get("user_id")):
            conn.execute("UPDATE public.source_accounts SET avatar_url = %s WHERE account_key = %s",
                         (record["avatar_url"], key))
        for kind, outcome, detail in checks:
            _add_check(conn, key, kind, outcome, at, "crawler",
                       {**detail, "raw_sha256": record.get("raw_sha256")})
        counts[record.get("status")] = counts.get(record.get("status"), 0) + 1
        if record.get("status") == "found" and _confirm_from_profile(conn, key, record, at):
            counts["identity_from_profile"] = counts.get("identity_from_profile", 0) + 1
    return counts


def _confirm_from_profile(conn, key, record, at):
    """Upgrade a third-party-listed account whose own profile says who it is."""
    acct = conn.execute(
        """SELECT a.identity_grade, a.owner_kind, a.org_name, p.name AS person_name, a.person_id
             FROM public.source_accounts a LEFT JOIN public.people p ON p.person_id = a.person_id
            WHERE a.account_key = %s""", (key,)).fetchone()
    target = ontology_schema.rule("rule:identity-from-profile")["expression"]["grade"]
    if acct is None or _grade_rank(acct["identity_grade"]) >= _grade_rank(target):
        return False
    orgs = [r["org_name"] for r in conn.execute(
        """SELECT org_name FROM public.person_affiliations
            WHERE person_id = %s AND relation <> 'former'""", (acct["person_id"],)).fetchall()] \
        if acct["person_id"] else []
    name = acct["person_name"] or acct["org_name"]
    profile = {"name": record.get("name"), "description": record.get("description")}
    if not name or not profile_confirms_identity(profile, name, orgs, acct["owner_kind"]):
        return False
    _add_check(conn, key, "identity", "pass", at, "crawler",
               {"grade": target, "from": "profile", "name": record.get("name"),
                "raw_sha256": record.get("raw_sha256")})
    conn.execute("UPDATE public.source_accounts SET identity_grade = %s WHERE account_key = %s", (target, key))
    return True


_TITLES = {"dr", "prof", "professor", "mr", "ms", "mrs", "phd"}


def _plain(text):
    import unicodedata
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower()


def _name_tokens(text):
    return [t for t in re.findall(r"[^\W_]+", _plain(text)) if t not in _TITLES]


def profile_confirms_identity(profile, expected_name, orgs, owner_kind="person", model=None):
    """rule:identity-from-profile. Pure."""
    rule = ontology_schema.rule("rule:identity-from-profile", model)["expression"]
    want = _name_tokens(expected_name)
    have = set(_name_tokens(profile.get("name")))
    if not want or not set(want) <= have:
        return False
    if owner_kind == "organization":
        return True
    bio = re.sub(r"[^\w]", "", _plain(profile.get("description")))
    for org in orgs:
        key = re.sub(r"[^\w]", "", _plain(org_key(org)))
        if len(key) >= rule["min_org_key_length"] and key in bio:
            return True
    return False
