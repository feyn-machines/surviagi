"""The Chinese wording of observations (Issue #78, ontology 2.9.0).

The extractor writes an observation in English, so a Chinese page showed English
cards. This pass fills the `*_zh_cn` columns, for new observations and for old ones
alike: whatever has no translation yet is what it reads, so a fact a later run adds
to an old observation is translated the same way. It runs after the mapping pass,
so an observation merged away costs nothing.

It is a call of its own and not a part of the observation prompt: asked in one call,
the model trades one output for another (see `observation_extraction`), and a failed
translation must not cost an observation. A translation is a reading aid
(rule:translation-is-a-reading-aid): it takes no part in the identity, nor in any
judgment, and the quotes stay the post's own words.

A wording that is already Chinese, has no letters to translate, or is a proper name
is copied without a call. An answer that changes a number's value or stays in English
is refused and asked again by the next pass; until then the reader gets the original.
"""

import hashlib
import json
import re
from datetime import datetime, timezone
from secrets import token_hex

from . import deepseek

BATCH = 20
WORKERS = 4

OBSERVATION_FIELDS = {"task": "task", "scale": "scale", "conditions": "conditions", "actor": "actor_name"}
FACT_FIELDS = {"what": "what", "unit": "unit"}

_CJK = re.compile(r"[㐀-䶿一-鿿]")
_LETTERS = re.compile(r"[^\W\d_]")
_LATIN_WORD = re.compile(r"[A-Za-z]{3,}")
_NAME = re.compile(r"^[@\dA-Z][^\s]*(?:\s+[\d(A-Z&][^\s]*)*$")
_NUMBER = re.compile(r"(\d+(?:[.,]\d+)*)(?:[\s-]*(thousand|million|billion|trillion|[kmbt](?![a-z])))?", re.I)
_SIZE = {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6, "b": 1e9, "billion": 1e9, "t": 1e12, "trillion": 1e12}
_ZH_NUMBER = re.compile(r"(\d+(?:[.,]\d+)*)\s*(万亿|千万|百万|十亿|万|亿|千)?")
_ZH_SIZE = {"千": 1e3, "万": 1e4, "百万": 1e6, "千万": 1e7, "亿": 1e8, "十亿": 1e9, "万亿": 1e12}
# An ordinary English word in a unit has a Chinese form; these technical ones do not.
_PLAIN_UNIT_WORD = re.compile(r"\b(?!tok(?:ens?)?\b)[a-z]{3,}\b")


def prompt():
    return "\n".join([
        "You translate short descriptions of how AI was used at work into Simplified Chinese, for "
        "readers of a Chinese website who are not engineers. You are given a list of items, each "
        "with an id and some of these fields: task, scale, conditions, actor, facts (each with an "
        "id and some of what, unit).",
        "- Write the plain, natural Chinese a Chinese writer would use, not a word-for-word rendering. "
        "Say exactly what the English says: add nothing, leave nothing out, explain nothing.",
        "- Keep the names of companies, products, models, people, account handles and code as "
        "written, in Latin letters (OpenAI, Claude Code, GPT-5.5, @handle). Put a space between "
        "Chinese and Latin letters or digits.",
        "- Keep every number in digits with its exact value. It may be written the Chinese way "
        "(\"1.2 million\" as \"120 万\", \"200,000\" as \"20 万\"). Keep 24/7, Q4, 3D, #1 and version "
        "numbers as written.",
        "- actor: when it is a proper name or an account handle, return it unchanged; when it only "
        "describes someone (\"a Virginia librarian\", \"banks\"), translate it.",
        "- unit: a short Chinese measure when there is one (minutes: 分钟, USD: 美元, USD million: "
        "百万美元, x: 倍, people: 人, hires: 人, days: 天); a technical unit with no Chinese form stays as "
        "written (tok/s, GB, ms).",
        "Return STRICT JSON: {\"translations\": [{\"id\": ..., the same fields, \"facts\": [{\"id\": ..., "
        "the same fields}]}]}, one for each item given, keeping ids exactly. Output ONLY the JSON object.",
    ])


def prompt_sha256():
    return hashlib.sha256(prompt().encode()).hexdigest()


def copied_as_is(field, text):
    """The wording itself when it needs no translation, else None."""
    if not _LETTERS.search(text) or len(_CJK.findall(text)) * 3 >= len(_LETTERS.findall(text)):
        return text
    if field == "actor" and _NAME.match(text):
        return text
    return None


def _value(digits, size):
    """The number, or None for what only looks like one: "5.5.1" is a version."""
    try:
        return float(digits.replace(",", "")) * size
    except ValueError:
        return None


def numbers_hold(source, answer):
    """Every number of the source is in the answer, as written or at the same value.

    "1.2 million" may be "120 万" and "200,000" may be "20 万"; "1.2 million" as "12 万" is refused.
    """
    written, values = set(), []
    for digits, size in _ZH_NUMBER.findall(answer):
        if not size:
            written.add(digits.replace(",", ""))
        values.append(_value(digits, _ZH_SIZE.get(size, 1)))
    for digits, size in _NUMBER.findall(source):
        value = _value(digits, _SIZE.get(size.lower(), 1))
        same = value is not None and any(other is not None and abs(value - other) <= value * 1e-9 for other in values)
        if digits.replace(",", "") not in written and not same:
            return False
    return True


def checked(field, source, answer):
    """The translation when it holds, else None."""
    if not isinstance(answer, str) or not answer.strip():
        return None
    answer = answer.strip()
    if not _CJK.search(answer):
        # A wording that is itself a name may rightly stay as it is ("Finance & Accounting Index").
        sentence = field in ("task", "scale", "conditions", "what") and _LATIN_WORD.search(source)
        if (sentence and not (answer == source and _NAME.match(source))) or (field == "unit" and _PLAIN_UNIT_WORD.search(source)):
            return None
    return answer if numbers_hold(source, answer) else None


def pending(conn):
    """Observations with a wording not translated yet, with the facts still to translate.

    Rows merged away and rows a person rejected are not published, so are not read.
    """
    rows = conn.execute("""
        SELECT o.observation_id, o.task, o.task_zh_cn, o.scale, o.scale_zh_cn, o.conditions,
               o.conditions_zh_cn, o.actor_name, o.actor_name_zh_cn,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('fact_id', f.fact_id, 'what', f.what, 'what_zh_cn', f.what_zh_cn,
                                                             'unit', f.unit, 'unit_zh_cn', f.unit_zh_cn) ORDER BY f.fact_id)
                           FROM observation_facts f
                          WHERE f.observation_id = o.observation_id
                            AND (f.what_zh_cn IS NULL OR (f.unit IS NOT NULL AND f.unit_zh_cn IS NULL))), '[]') AS facts
          FROM observations o
         WHERE o.review_state <> 'human_rejected'
           AND NOT EXISTS (SELECT 1 FROM observation_merges m WHERE m.observation_id = o.observation_id)
         ORDER BY o.observation_id
    """).fetchall()
    return [row for row in rows if _missing(row) or row["facts"]]


def _missing(row):
    return {field: row[column] for field, column in OBSERVATION_FIELDS.items()
            if row[column] and not row[f"{column}_zh_cn"]}


def plan(rows):
    """What each row needs: words copied as they are, and the items to ask about."""
    copies, facts_copied, items = {}, {}, []
    for row in rows:
        item = {"id": row["observation_id"]}
        for field, text in _missing(row).items():
            same = copied_as_is(field, text)
            if same is None:
                item[field] = text
            else:
                copies.setdefault(row["observation_id"], {})[field] = same
        asked = []
        for fact in row["facts"]:
            entry = {"id": fact["fact_id"]}
            for field in FACT_FIELDS:
                text = fact[field]
                if not text or fact[f"{field}_zh_cn"]:
                    continue
                same = copied_as_is(field, text)
                if same is None:
                    entry[field] = text
                else:
                    facts_copied.setdefault(fact["fact_id"], {})[field] = same
            if len(entry) > 1:
                asked.append(entry)
        if asked:
            item["facts"] = asked
        if len(item) > 1:
            items.append(item)
    return copies, facts_copied, items


def read_answers(items, batches):
    """(observations, facts, refused): the checked wordings of the model's answers, by id."""
    answers = {answer.get("id"): answer for batch in batches for answer in batch.get("translations") or []
               if isinstance(answer, dict)}
    observations, facts = {}, {}
    refused = 0

    def take(source, answer, names, into):
        nonlocal refused
        for field in names:
            if field not in source:
                continue
            wording = checked(field, source[field], answer.get(field))
            if wording is None:
                refused += 1
            else:
                into[field] = wording

    for item in items:
        answer = answers.get(item["id"])
        if answer is None:
            continue
        take(item, answer, OBSERVATION_FIELDS, observations.setdefault(item["id"], {}))
        said = {fact.get("id"): fact for fact in answer.get("facts") or [] if isinstance(fact, dict)}
        for fact in item.get("facts", []):
            if fact["id"] in said:
                take(fact, said[fact["id"]], FACT_FIELDS, facts.setdefault(fact["id"], {}))
    return ({key: value for key, value in observations.items() if value},
            {key: value for key, value in facts.items() if value}, refused)


def _write(conn, table, key, row_id, wordings, columns, run_id):
    # COALESCE: a translation already there is never overwritten by a later pass.
    sets = ", ".join(f"{columns[field]}_zh_cn = COALESCE({columns[field]}_zh_cn, %s)" for field in wordings)
    conn.execute(f"UPDATE public.{table} SET {sets}, translation_run_id = %s WHERE {key} = %s",
                 (*wordings.values(), run_id, row_id))


def translate(conn, cfg=None, progress=None, limit=None):
    rows = pending(conn)
    if limit is not None:
        rows = rows[:limit]
    copies, facts_copied, items = plan(rows)
    counts = {"pending": len(rows), "asked": len(items), "observations": 0, "facts": 0, "copied": 0, "refused": 0,
              "failed_batches": 0, "cost_usd": 0.0}
    if not rows:
        return {"run_id": None, **counts}
    batches, failures, usage = [], [], []
    if items:
        cfg = cfg or deepseek.config_from_env()
        system = prompt()
        chunks = [items[start:start + BATCH] for start in range(0, len(items), BATCH)]
        batches, failures = deepseek._run_batches(
            chunks, lambda chunk: [{"role": "system", "content": system},
                                   {"role": "user", "content": json.dumps({"items": chunk}, ensure_ascii=False)}],
            ("translations",), cfg, progress, 3, WORKERS, usage)
    observations, facts, refused = read_answers(items, batches)
    counts.update(observations=len(observations), facts=len(facts), refused=refused, failed_batches=len(failures),
                  copied=sum(map(len, copies.values())) + sum(map(len, facts_copied.values())),
                  cost_usd=round(deepseek.billed_usd(usage), 4) if usage else 0.0)
    run_id = f"translate-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{token_hex(3)}"
    with conn.transaction():
        conn.execute("INSERT INTO observation_translation_runs (run_id, model, prompt_sha256, counts) VALUES (%s, %s, %s, %s)",
                     (run_id, cfg and cfg["model"], prompt_sha256(), json.dumps(counts)))
        for row_id in {*copies, *observations}:
            _write(conn, "observations", "observation_id", row_id,
                   {**copies.get(row_id, {}), **observations.get(row_id, {})}, OBSERVATION_FIELDS, run_id)
        for row_id in {*facts_copied, *facts}:
            _write(conn, "observation_facts", "fact_id", row_id,
                   {**facts_copied.get(row_id, {}), **facts.get(row_id, {})}, FACT_FIELDS, run_id)
    return {"run_id": run_id, **counts, "failures": failures}
