"""Which model an update is about.

Runs after extraction and leaves it alone: event identity, subject_key and the
extraction prompt are untouched, so the stored events stay what they were and
this step can be re-run by itself.

Two halves. The judge reads an update and returns every model name it finds,
verbatim, with a role - it never picks a registry row. A deterministic resolver
then looks the name up in the alias table. A name with no alias opens a
candidate model; the owner's own release update confirms it.

Products are not models: Codex, Copilot Cowork or the Gemini app never reach the
registry.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from secrets import token_hex

from . import deepseek
from .event_extraction import resolve_org
from .pipeline import ROOT, digest

METHOD_VERSION = "model-identification-1"
ROLES = ("subject", "adopted", "distributed", "compared")
RELEASE_KINDS = ("version_release", "product_launch")
TEXT_LIMIT = 4000

SYSTEM = "\n".join([
    "You read records of AI updates and list the AI MODELS each one names.",
    "",
    "A model is a trained model or a model family that a vendor releases under a name: "
    "GPT-6 Astra, Claude Fable 5.1, Gemini 3.8 Flash, Qwen3.8, Llama, SAM 3.1, Wan 2.7.",
    "A product, app, agent, feature, platform or service is NOT a model, even when it runs on "
    "one and even when it shares a brand with one: ChatGPT, Codex, Claude Code, Claude Cowork, "
    "the Gemini app, Gemini Enterprise, NotebookLM, GitHub Copilot, Copilot Cowork, Microsoft "
    "Foundry, Devin. Do not list them. \"Gemini\" or \"Claude\" used for the app is not a model "
    "mention; list the family only when the text means the model.",
    "",
    "For every model named in an update return:",
    '- "mention": the name exactly as the text writes it',
    '- "name": the release name as its owner writes it, without a date or build suffix '
    '("Grok 4.6" for "grok-4.6-0903"); for a mention that gives no version, the family name',
    '- "family": the family name ("GPT", "Claude", "Gemini", "Qwen")',
    '- "version": the version as written ("3.8", "6"), or null when the text gives none',
    '- "variant": the variant ("Flash", "Pro", "mini"), or null. When the name does not split '
    'cleanly into version and variant, leave both null',
    '- "owner": the company that makes the model, as one plain name',
    '- "role": one of',
    '    "subject"     - the update releases this model or changes the model itself',
    '    "adopted"     - someone builds on it or uses it: an integration, a customer, a demo, '
    'a contest or a piece of work made with it',
    '    "distributed" - it becomes available on another platform, cloud or service',
    '    "compared"    - it is named in a benchmark, ranking or comparison, including its own '
    'vendor reporting where it ranks',
    '- "confidence": number 0..1',
    "",
    "Use only the given text. Never infer a version the text does not state. An update that "
    "names no model gets an empty list.",
    "",
    'Return STRICT JSON: {"updates": [{"id": <the given id>, "models": [ ... ]}]}, one entry '
    "for every given id. Output ONLY the JSON object.",
])


def prompt_sha256():
    return digest({"system": SYSTEM, "method_version": METHOD_VERSION})


def normalize(name):
    """Surface form -> alias key: `Gemini 3.8-Flash` and `gemini-3.8 flash` meet."""
    text = re.sub(r"(\d)\.0(?!\d)", r"\1", str(name or "").lower())  # Wan 3.0 is Wan 3
    text = re.sub(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", " ", text)  # qwen3 is qwen 3
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def _slug(name):
    return normalize(name).replace(" ", "-")


def _text(value):
    value = value.strip() if isinstance(value, str) else ""
    return value or None


def clean_mentions(raw):
    """The judge's list for one update -> well-formed mentions; anything else is dropped."""
    out = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        mention, role = _text(item.get("mention")), item.get("role")
        name = _text(item.get("name")) or mention
        if not mention or role not in ROLES or not normalize(name):
            continue
        family = _text(item.get("family"))
        version, variant = _text(str(item["version"]) if item.get("version") is not None else ""), \
            _text(item.get("variant"))
        try:
            confidence = min(1.0, max(0.0, float(item.get("confidence"))))
        except (TypeError, ValueError):
            confidence = None
        out.append({"mention": mention, "name": name, "family": family, "version": version,
                    "variant": variant, "owner": _text(item.get("owner")), "role": role,
                    "confidence": confidence})
    return out


class Registry:
    """The model registry in memory: resolves a mention, opening candidates as needed.

    `models` maps model_id -> row and `aliases` maps alias -> model_id; `new_models`
    and `new_aliases` collect what this pass added, for the caller to write.
    """

    def __init__(self, models=(), aliases=()):
        self.models = {m["model_id"]: dict(m) for m in models}
        self.aliases = dict(aliases)
        self.new_models, self.new_aliases = [], []

    def _alias(self, name, model_id, of=None):
        """Record a spelling. A mention is taken as a spelling of `of` only when it adds
        nothing but a date or build number: `Qwen3.8-Max` is not a spelling of `Qwen3.8`."""
        key = normalize(name)
        if of is not None:
            extra = set(key.split()) - set(normalize(of).split())
            if any(not token.isdigit() for token in extra):
                return
        if key and key not in self.aliases:
            self.aliases[key] = model_id
            self.new_aliases.append((key, model_id))

    def _open(self, model_id, row):
        if model_id not in self.models:
            self.models[model_id] = row = {"model_id": model_id, "status": "candidate", **row}
            self.new_models.append(row)
        return model_id

    def resolve(self, mention, event_id):
        """A cleaned mention -> model_id. Never guesses a version the mention lacks."""
        for name in (mention["mention"], mention["name"]):
            hit = self.aliases.get(normalize(name))
            if hit:
                self._alias(mention["mention"], hit, of=self.models[hit]["name"])
                return hit
        org_id = resolve_org(mention["owner"]) if mention["owner"] else None
        owner = org_id.split(":", 1)[1] if org_id else (_slug(mention["owner"]) or "unknown")
        owner_name = None if org_id else mention["owner"]
        base = {"org_id": org_id, "owner_name": owner_name, "first_seen_event_id": event_id}

        family = mention["family"] or mention["name"]
        family_id = self.aliases.get(normalize(family))
        if family_id is None or self.models[family_id]["level"] != "family":
            family_id = self._open(f"model:{owner}:{_slug(family)}", {
                **base, "level": "family", "parent_model_id": None, "name": family,
                "version": None, "variant": None})
            self._alias(family, family_id)
        is_family = normalize(mention["name"]) == normalize(family) and not mention["version"] \
            and not mention["variant"]
        if is_family:
            self._alias(mention["mention"], family_id, of=family)
            return family_id
        model_id = self._open(f"model:{owner}:{_slug(mention['name'])}", {
            **base, "level": "release", "parent_model_id": family_id, "name": mention["name"],
            "version": mention["version"], "variant": mention["variant"]})
        self._alias(mention["name"], model_id)
        self._alias(mention["mention"], model_id, of=mention["name"])
        return model_id


def links_for(registry, event_id, mentions):
    """One update's cleaned mentions -> event_models rows, one per (model, role)."""
    rows = {}
    for mention in mentions:
        model_id = registry.resolve(mention, event_id)
        key = (model_id, mention["role"])
        best = rows.get(key)
        if best is None or (mention["confidence"] or 0) > (best["confidence"] or 0):
            rows[key] = {"event_id": event_id, "model_id": model_id, "role": mention["role"],
                         "mention": mention["mention"], "confidence": mention["confidence"]}
    return list(rows.values())


EVENTS_SQL = """
    SELECT e.event_id, e.title, e.summary, e.kind, e.primary_org,
           (SELECT string_agg(t.text, E'\\n---\\n')
              FROM (SELECT DISTINCT ON (s.source_id) coalesce(c.full_text, c.public_excerpt) AS text
                      FROM public.extracted_event_sources s
                      JOIN public.collected_captures c ON c.source_id = s.source_id
                     WHERE s.event_id = e.event_id
                     ORDER BY s.source_id, c.captured_at DESC) t) AS posts
      FROM public.extracted_events e
     WHERE NOT EXISTS (SELECT 1 FROM public.event_model_checks k
                        WHERE k.event_id = e.event_id AND k.method_version = %s)
     ORDER BY e.occurred_at NULLS LAST, e.event_id
"""


def _message(events):
    lines = ["Updates:"]
    for event in events:
        lines.append(json.dumps({
            "id": event["event_id"], "company": event["primary_org"], "kind": event["kind"],
            "title": event["title"], "summary": event["summary"],
            "posts": (event["posts"] or "")[:TEXT_LIMIT]}, ensure_ascii=False))
    return "\n".join(lines)


def ask(events, cfg, attempts=3):
    """One batch -> {event_id: cleaned mentions}. An id the judge left out is absent."""
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _message(events)}]
    error = None
    for _ in range(attempts):
        try:
            answer = deepseek.chat(messages, cfg)
        except deepseek.DeepSeekError as failure:
            error = failure
            continue
        wanted = {e["event_id"] for e in events}
        return {u["id"]: clean_mentions(u.get("models")) for u in answer.get("updates") or []
                if isinstance(u, dict) and u.get("id") in wanted}
    raise error


def confirm(conn):
    """A candidate is confirmed by its owner's own release update, which also dates it."""
    conn.execute(
        """UPDATE public.models m SET status = 'confirmed', released_at = r.released_at
             FROM (SELECT em.model_id, min(e.occurred_at) AS released_at
                     FROM public.event_models em
                     JOIN public.extracted_events e ON e.event_id = em.event_id
                     JOIN public.models x ON x.model_id = em.model_id
                    WHERE em.role = 'subject' AND e.kind = ANY(%s)
                      AND x.level = 'release' AND e.primary_org_id = x.org_id
                    GROUP BY em.model_id) r
            WHERE m.model_id = r.model_id""", (list(RELEASE_KINDS),))
    conn.execute(
        """UPDATE public.models f SET status = 'confirmed'
            WHERE f.level = 'family' AND f.status = 'candidate'
              AND EXISTS (SELECT 1 FROM public.models c
                           WHERE c.parent_model_id = f.model_id AND c.status = 'confirmed')""")


def short_names(models):
    """Spellings that drop the family name: `opus 5 5` for Claude Opus 5.5.

    A post often omits the brand. The short form is offered only when it starts
    with a word and still carries a version number - `3 8 flash` or a bare `5 6`
    names nothing on its own - and exactly one model would answer to it.
    Returns {short name: model_id}.
    """
    by_id = {m["model_id"]: m for m in models}
    found, clash = {}, set()
    for model in models:
        family = by_id.get(model.get("parent_model_id"))
        if model["level"] != "release" or family is None:
            continue
        name, prefix = normalize(model["name"]).split(), normalize(family["name"]).split()
        rest = name[len(prefix):]
        if name[:len(prefix)] != prefix or len(rest) < 2 or not rest[0].isalpha() \
                or not any(t.isdigit() for t in rest):
            continue
        short = " ".join(rest)
        if short in found and found[short] != model["model_id"]:
            clash.add(short)
        found[short] = model["model_id"]
    return {short: model_id for short, model_id in found.items() if short not in clash}


def reconcile(conn):
    """Rule-only repair of the registry; no judge is called.

    A candidate that a mention opened under a short name ("Opus 5.5") is folded
    into the model of the same owner that the short name belongs to, and every
    short name becomes an alias so the next mention resolves directly.
    """
    models = conn.execute("SELECT * FROM public.models").fetchall()
    by_id = {m["model_id"]: m for m in models}
    aliases = {r["alias"]: r["model_id"] for r in
               conn.execute("SELECT alias, model_id FROM public.model_aliases").fetchall()}
    merged, added = [], 0
    for short, target in short_names(models).items():
        holder = aliases.get(short)
        if holder is None:
            conn.execute("INSERT INTO public.model_aliases (alias, model_id) VALUES (%s, %s)", (short, target))
            added += 1
            continue
        duplicate = by_id[holder]
        if holder == target or duplicate["org_id"] != by_id[target]["org_id"] or duplicate["level"] != "release" \
                or duplicate["status"] != "candidate" or duplicate["catalog_id"] or normalize(duplicate["name"]) != short:
            continue  # the short name already means something else; leave both alone
        conn.execute(
            """DELETE FROM public.event_models d USING public.event_models k
                WHERE d.model_id = %s AND k.model_id = %s AND k.event_id = d.event_id AND k.role = d.role""",
            (holder, target))
        conn.execute("UPDATE public.event_models SET model_id = %s WHERE model_id = %s", (target, holder))
        conn.execute("UPDATE public.model_aliases SET model_id = %s WHERE model_id = %s", (target, holder))
        conn.execute("DELETE FROM public.models WHERE model_id = %s", (holder,))
        merged.append({"from": holder, "into": target})
    # A family opened only for a duplicate that is now gone has nothing left under it.
    emptied = conn.execute(
        """DELETE FROM public.models f
            WHERE f.level = 'family' AND f.status = 'candidate' AND f.catalog_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.models c WHERE c.parent_model_id = f.model_id)
              AND NOT EXISTS (SELECT 1 FROM public.event_models em WHERE em.model_id = f.model_id)
              AND f.model_id = ANY(%s)
        RETURNING f.model_id""",
        ([by_id[m["from"]]["parent_model_id"] for m in merged if by_id[m["from"]]["parent_model_id"]],)).fetchall()
    return {"merged": merged, "short_aliases_added": added, "empty_families_removed": [r["model_id"] for r in emptied]}


def report(conn):
    one = lambda sql: conn.execute(sql).fetchone()
    return {
        "events": one("SELECT count(*) AS n FROM public.extracted_events")["n"],
        "events_read": one("SELECT count(*) AS n FROM public.event_model_checks")["n"],
        "events_with_model": one("SELECT count(DISTINCT event_id) AS n FROM public.event_models")["n"],
        "links_by_role": {r["role"]: r["n"] for r in conn.execute(
            "SELECT role, count(*) AS n FROM public.event_models GROUP BY role ORDER BY role").fetchall()},
        "models": {f"{r['level']}/{r['status']}": r["n"] for r in conn.execute(
            "SELECT level, status, count(*) AS n FROM public.models GROUP BY 1, 2 ORDER BY 1, 2").fetchall()},
        "aliases": one("SELECT count(*) AS n FROM public.model_aliases")["n"],
    }


def run(conn, batch_size=8, limit=None, progress=print):
    """Identify models for every update not yet read under this method version."""
    events = conn.execute(EVENTS_SQL, (METHOD_VERSION,)).fetchall()
    if limit:
        events = events[:limit]
    if not events:
        confirm(conn)
        return {"read": 0, **report(conn)}
    deepseek.load_env(ROOT)
    cfg = deepseek.config_from_env()
    registry = Registry(
        conn.execute("SELECT * FROM public.models").fetchall(),
        [(r["alias"], r["model_id"]) for r in conn.execute("SELECT alias, model_id FROM public.model_aliases").fetchall()])
    run_id = f"models-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{token_hex(3)}"
    conn.execute(
        """INSERT INTO public.judgment_runs
             (run_id, judge, model, task, prompt_sha256, rubric_sha256, method_version,
              params, started_at, status, item_count, decided_count, run_sha256)
           VALUES (%s, 'deepseek', %s, 'model_identification', %s, %s, %s, %s::jsonb, %s, 'running', %s, 0, %s)""",
        (run_id, cfg["model"], prompt_sha256(), digest({"roles": ROLES, "release_kinds": RELEASE_KINDS}),
         METHOD_VERSION, json.dumps({"batch_size": batch_size, "limit": limit}),
         datetime.now(timezone.utc), len(events),
         digest({"events": [e["event_id"] for e in events], "method_version": METHOD_VERSION})))
    read = failed = 0
    try:
        for start in range(0, len(events), batch_size):
            batch = events[start:start + batch_size]
            try:
                answers = ask(batch, cfg)
            except deepseek.DeepSeekError as error:
                failed += len(batch)
                progress(f"batch at {start} failed: {error}")
                continue
            with conn.transaction():
                for event in batch:
                    event_id = event["event_id"]
                    if event_id not in answers:  # left unread, picked up by the next run
                        failed += 1
                        continue
                    links = links_for(registry, event_id, answers[event_id])
                    for row in registry.new_models:
                        conn.execute(
                            """INSERT INTO public.models
                                 (model_id, org_id, owner_name, level, parent_model_id, name, version,
                                  variant, status, first_seen_event_id)
                               VALUES (%(model_id)s, %(org_id)s, %(owner_name)s, %(level)s,
                                       %(parent_model_id)s, %(name)s, %(version)s, %(variant)s,
                                       %(status)s, %(first_seen_event_id)s)
                               ON CONFLICT (model_id) DO NOTHING""", row)
                    for alias, model_id in registry.new_aliases:
                        conn.execute("INSERT INTO public.model_aliases (alias, model_id) VALUES (%s, %s) "
                                     "ON CONFLICT (alias) DO NOTHING", (alias, model_id))
                    registry.new_models, registry.new_aliases = [], []
                    conn.execute("DELETE FROM public.event_models WHERE event_id = %s", (event_id,))
                    for link in links:
                        conn.execute(
                            """INSERT INTO public.event_models (event_id, model_id, role, mention, confidence, run_id)
                               VALUES (%(event_id)s, %(model_id)s, %(role)s, %(mention)s, %(confidence)s, %(run_id)s)""",
                            {**link, "run_id": run_id})
                    conn.execute(
                        """INSERT INTO public.event_model_checks (event_id, run_id, method_version, mentions, checked_at)
                           VALUES (%s, %s, %s, %s, %s)
                           ON CONFLICT (event_id) DO UPDATE SET run_id = excluded.run_id,
                             method_version = excluded.method_version, mentions = excluded.mentions,
                             checked_at = excluded.checked_at""",
                        (event_id, run_id, METHOD_VERSION, len(links), datetime.now(timezone.utc)))
                    read += 1
            progress(f"{min(start + batch_size, len(events))}/{len(events)} updates read")
    except BaseException:
        conn.execute("UPDATE public.judgment_runs SET status = 'failed', finished_at = %s, decided_count = %s "
                     "WHERE run_id = %s", (datetime.now(timezone.utc), read, run_id))
        raise
    with conn.transaction():
        reconciled = reconcile(conn)
    confirm(conn)
    conn.execute("UPDATE public.judgment_runs SET status = 'completed', finished_at = %s, decided_count = %s "
                 "WHERE run_id = %s", (datetime.now(timezone.utc), read, run_id))
    return {"run_id": run_id, "read": read, "unread": failed, "reconciled": reconciled, **report(conn)}
