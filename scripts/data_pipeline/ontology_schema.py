"""Python view of the ontology schema (datasets/ontology/schema/schema.json).

The schema is the one type definition: classes, properties, relations,
controlled vocabularies and constraints. The CHECK constraints in db/migrations,
the site labels and the extraction prompt are projections of it, never
hand-typed lists. This module is the Python half of that, mirroring
scripts/lib/ontology-schema.mjs; the Node side projects SQL and labels, this
side feeds the extraction prompt and the extractor's vocabularies.

Stdlib only, and it reads nothing but the schema file: the extraction unit tests
run under the system python with no psycopg and no network.
"""
from __future__ import annotations

import hashlib
import json
import math
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "datasets" / "ontology" / "schema" / "schema.json"

# Markers written on every governed row. A row extracted under the old free-text
# list keeps LEGACY_VOCABULARY and its old value, so past aggregates stay
# reproducible while new writes are constrained. These two strings are part of the
# SQL CHECK in migration 006 and must stay identical to the constants in
# scripts/build-ontology-projections.mjs.
LEGACY_VOCABULARY = "legacy-freeform"

# Language order used when rendering a bilingual field into prompt text.
_LANGS = ("zh-CN", "en")


@lru_cache(maxsize=4)
def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_schema(path=None):
    """The parsed schema. Cached: it is immutable within a run.

    The returned dict is shared, so callers must not mutate it. Every function
    here takes an optional `model` instead, which is how a test renders a
    modified rubric without touching the file on disk.
    """
    return _read(str(path or SCHEMA_PATH))


SCHEMA_VERSION = load_schema()["version"]
# The event_kind vocabulary carries its own version: it is what the row marker
# names and what the rubric hash covers. The schema version moves when any type
# is added or the definition is restructured; a classification is only
# comparable across runs if that does not disturb it.
EVENT_KIND_VERSION = load_schema()["vocabularies"]["event_kind"]["version"]
# The marker a row written now carries, and the markers a reader accepts. A term
# added to the vocabulary gives new rows a new marker; the rows already stored
# keep theirs and their values (rule:definitions-take-effect-forward). Reading by
# equality with the current marker would therefore drop every earlier update
# from links, routing and the published snapshot the day the vocabulary moved.
EVENT_KIND_VOCABULARY = f"event_kind-{EVENT_KIND_VERSION}"
EVENT_KIND_VOCABULARIES = [f"event_kind-{version}" for version in
                           load_schema()["vocabularies"]["event_kind"].get("lineage") or [EVENT_KIND_VERSION]]


def event_kind_markers(vocabulary=None):
    """Markers to read: every version of the lineage, or the one that was asked for."""
    return [vocabulary] if vocabulary else list(EVENT_KIND_VOCABULARIES)


def event_identity(model=None):
    """The identity rule of an update, which the schema keeps on the Event class."""
    return ((model or load_schema()).get("classes") or {}).get("Event", {}).get("identity") or {}


def _vocabulary(name, model=None):
    vocabularies = (model or load_schema()).get("vocabularies") or {}
    if name not in vocabularies:
        raise KeyError(f"Unknown vocabulary: {name}")
    return vocabularies[name]


def term_ids(name, model=None):
    """Term ids of a vocabulary, in declaration order, whatever shape it uses."""
    terms = _vocabulary(name, model).get("terms")
    if isinstance(terms, list):
        return list(terms)
    if isinstance(terms, dict):
        return list(terms)
    raise ValueError(f"Vocabulary {name} has no terms")


def _version_tuple(version):
    return tuple(int(part) for part in str(version).split("."))


def current_term_ids(name, model=None):
    """Term ids a row written today may carry: without those retired by `until`.

    A retired term stays in the schema so the rows that carry it can still be
    read and labelled (rule:definitions-take-effect-forward).
    """
    model = model or load_schema()
    vocabulary = _vocabulary(name, model)
    now = _version_tuple(vocabulary.get("version") or model["version"])
    terms = vocabulary.get("terms")
    if not isinstance(terms, dict):
        return term_ids(name, model)
    return [term_id for term_id, body in terms.items()
            if not (isinstance(body, dict) and body.get("until") and _version_tuple(body["until"]) < now)]


def term(name, term_id, model=None):
    """Term body, or an empty dict for list-shaped vocabularies; None if absent."""
    terms = _vocabulary(name, model).get("terms")
    if isinstance(terms, list):
        return {} if term_id in terms else None
    return (terms or {}).get(term_id)


# --- prompt rendering ----------------------------------------------------------

def _localized(value, prefix, indent="  "):
    """One bilingual field as prompt lines. A plain string renders unlabelled."""
    if value is None:
        return []
    if isinstance(value, str):
        return [f"{indent}{prefix}: {value}"] if value.strip() else []
    lines = []
    for lang in (*_LANGS, *(k for k in value if k not in _LANGS)):
        text = value.get(lang) if isinstance(value, dict) else None
        if isinstance(text, str) and text.strip():
            lines.append(f"{indent}{prefix} [{lang}]: {text}")
    return lines


def event_kind_rubric(model=None):
    """The event kinds a new row may carry, as prompt text: definition, boundary, both examples.

    The old prompt listed ten bare words with no definitions, so the model drew a
    different boundary on every run (availability 15.8% -> 5.1% between two runs of
    the same prompt) and parked 23.7% of events in "other". A word list cannot be
    reproduced; a rubric can. Every line here comes from the model file, so
    changing a boundary means editing the schema, not the prompt.
    """
    model = model or load_schema()
    vocabulary = _vocabulary("event_kind", model)
    ids = current_term_ids("event_kind", model)
    lines = [f"Controlled vocabulary `{EVENT_KIND_VOCABULARY}` - {len(ids)} terms, closed set:"]
    for position, term_id in enumerate(ids, 1):
        body = term("event_kind", term_id, model) or {}
        label = body.get("label") or {}
        names = " / ".join(str(label[lang]) for lang in _LANGS if label.get(lang))
        lines.append(f"[{position}/{len(ids)}] {term_id}" + (f"  ({names})" if names else ""))
        lines += _localized(body.get("definition"), "definition")
        lines += _localized(body.get("definition_why"), "why this kind exists")
        lines += _localized(body.get("discriminator"), "discriminator")
        lines += _localized(body.get("positive_example"), "positive example")
        lines += _localized(body.get("negative_example"), "negative example")
    if vocabulary.get("closed"):
        lines.append("This set is closed: no term may be invented, abbreviated or merged.")
    lines += _localized(vocabulary.get("no_other_bucket"), "no other bucket", indent="")
    unresolved = vocabulary.get("unresolved")
    if isinstance(unresolved, dict):
        lines += _localized({k: v for k, v in unresolved.items() if k in _LANGS},
                            "undecidable", indent="")
    return "\n".join(lines)


def event_identity_rule(model=None):
    """The event identity rule as prompt text: the triple, the subject, the window.

    Identity used to be slug(primary_org + title). Titles are natural language, so
    one announcement written four ways became four events (Qwen3.8-Max-0902 tops
    CodeArena WebDev, Apsara Conference 2026). The triple is what the model must
    supply instead, and subject_key is the part it has to name explicitly.
    """
    model = model or load_schema()
    identity = event_identity(model)
    fields = identity.get("identity_fields") or []
    lines = ["Event identity:"]
    lines.append(f"  identity = ({' + '.join(str(f) for f in fields)}); the title is display only.")
    lines += _localized(identity.get("rule"), "rule")
    lines += _localized(identity.get("subject_key"), "subject_key")
    lines += _localized(identity.get("occurrence_window"), "occurrence window")
    return "\n".join(lines)


def rubric_sha256(model=None):
    """Version anchor for the judgment rubric, recorded with every extraction run.

    Covers exactly what decides a classification: the event_kind term bodies, the
    identity rule and the event_kind vocabulary version. A boundary edited in the schema
    therefore shows up as a different hash in provenance, and two runs with the
    same hash are comparable.
    """
    model = model or load_schema()
    payload = {
        # Key kept from when the two versions were one, so hashes recorded then still match.
        "semantic_version": _vocabulary("event_kind", model).get("version"),
        "event_kind": _vocabulary("event_kind", model).get("terms"),
        "event_identity": event_identity(model) or None,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def rule(rule_id, model=None):
    """One constraint from the schema, by id.

    Rules are read rather than restated. A threshold copied into a scorer and
    into a publisher is two thresholds that agree until someone edits one.
    """
    model = model or load_schema()
    for entry in model.get("constraints") or []:
        if entry.get("id") == rule_id:
            return entry
    raise KeyError(f"unknown rule: {rule_id}")


def level_ids(model=None) -> list[int]:
    """The rungs of the activity ladder, in order. The id IS the value."""
    return [int(term_id) for term_id in term_ids("activity_level", model)]


def level_scale(model=None, language: str = "en") -> list[str]:
    """The ladder as the judge is shown it.

    A score question takes an ordered list and answers with an index, so this
    list IS L0-L5 and its order is load-bearing. It is projected from the
    vocabulary rather than typed into the prompt: a rung reworded here changes
    the question, and a prompt holding its own copy would quietly stop matching
    the scale the answers are recorded against.
    """
    model = model or load_schema()
    return [term("activity_level", str(value), model)["definition"][language]
            for value in level_ids(model)]


def level_labels(model=None) -> dict[str, dict[str, str]]:
    """Short bilingual labels per rung, for a legend or an axis."""
    model = model or load_schema()
    return {str(value): dict(term("activity_level", str(value), model)["label"])
            for value in level_ids(model)}


def level_definitions(model=None) -> dict[str, dict[str, str]]:
    """The full sentence per rung - the same line the judge was asked to apply.

    Published alongside the short labels so the website never restates the
    ladder in its own words. A component carrying its own "AI produces the
    bulk, a person checks every item" is the type layer copied into the
    rendering layer, and it drifts the first time the vocabulary is edited.
    """
    model = model or load_schema()
    return {str(value): dict(term("activity_level", str(value), model)["definition"])
            for value in level_ids(model)}


def level_caps(model=None) -> dict[str, float]:
    """The highest activity level each evidence tier can support.

    rule:tier-caps-level. Deliberately NOT evidence_tier.stage_cap: that is the
    cap on the retired 0-4 autonomy_stage and holds different numbers (T2 caps
    at 3 there and 4 here). The two agreed only at T3, which is how they stayed
    apart unnoticed while these values lived in Python.
    """
    model = model or load_schema()
    field = _vocabulary("activity_level", model)["capped_by"]["field"]
    return {tier: float(body[field])
            for tier, body in _vocabulary("evidence_tier", model)["terms"].items()}


def level_of_score(score):
    """The level a judge's score has reached: the largest whole level at or below it.

    Levels are categories, not a scale to average along. The judge was asked for
    a score and answers with numbers like 3.82; that means "past L3, short of
    L4", which is L3. Rounding to nearest would promote it to a level nothing
    showed. The raw score is kept on the evidence row for provenance.
    """
    return None if score is None else int(math.floor(float(score)))


def level_of_score_sql(column: str) -> str:
    """level_of_score as SQL, so the queries round the same way."""
    return f"floor({column})"


def gate_level_cap(model=None) -> int:
    """The highest level an activity behind a non-technical barrier can hold."""
    return int(rule("rule:gate-caps-level", model)["expression"]["cap"])


def min_level_score(model=None) -> float:
    """Judge scores below this are kept on record but are not a level."""
    return float(rule("rule:score-below-one-is-not-a-level", model)["expression"]["min_score"])


def nature_cap_sql(column: str = "ve.post_nature", model=None) -> str:
    """rule:nature-caps-level as SQL: the most a kind of post can show."""
    model = model or load_schema()
    terms = _vocabulary("post_nature", model)["terms"]
    arms = " ".join(f"WHEN '{t}' THEN {body['level_cap']}" for t, body in terms.items())
    return f"CASE {column} {arms} END"


def level_cap_sql(column: str = "ae.evidence_tier", model=None) -> str:
    """The cap as a SQL CASE, so the publisher's query restates nothing either."""
    arms = " ".join(f"WHEN '{tier}' THEN {cap}"
                    for tier, cap in level_caps(model).items())
    return f"CASE {column} {arms} END"


def breadth_threshold(model=None):
    """Share of judged work above which a capability stops discriminating.

    rule:breadth-limits-discrimination. Returned rather than hardcoded so the
    scorer, the publisher and the site all move together when it changes.
    """
    value = rule("rule:breadth-limits-discrimination", model)["expression"]["threshold"]
    return float(value)


def is_discriminating(work_nodes_requiring, work_nodes_judged, model=None):
    """Whether a capability still distinguishes between kinds of work.

    Unknown counts mean unknown, not "yes": a capability nobody has measured is
    not thereby cleared to carry an occupation-level conclusion. A capability
    that has been asked about zero times has no breadth to speak of, and is
    treated the same way.
    """
    if not work_nodes_judged or work_nodes_requiring is None:
        return None
    return (work_nodes_requiring / work_nodes_judged) <= breadth_threshold(model)
