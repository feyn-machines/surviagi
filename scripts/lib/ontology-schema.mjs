// Loader and validator for the ontology schema: the one type definition. SQL
// CHECK constraints, extraction prompts, judgment rubrics and site labels are
// all projected from it. Nothing here reads the database.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const schemaPath = join(root, "datasets", "ontology", "schema", "schema.json");

export const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

/** Gate definitions, which are instances and live beside the schema, not in it. */
export const gatesPath = join(root, "datasets", "ontology", "data", "gates.json");
export const gates = JSON.parse(readFileSync(gatesPath, "utf8"));

/** Term ids of a vocabulary, in declaration order, whatever shape it uses. */
export function termIds(name) {
  const vocabulary = schema.vocabularies[name];
  if (!vocabulary) throw new Error(`Unknown vocabulary: ${name}`);
  const terms = vocabulary.terms;
  if (Array.isArray(terms)) return [...terms];
  if (terms && typeof terms === "object") return Object.keys(terms);
  throw new Error(`Vocabulary ${name} has no terms`);
}

const versionParts = (version) => String(version).split(".").map(Number);
const notAfter = (a, b) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
  return true;
};

/** Term ids as the vocabulary stood at one of its own versions.
 *
 * A term that says `since` did not exist before that version
 * (rule:definitions-take-effect-forward). An applied migration is frozen, so
 * the text generated for it has to keep naming the terms of its day; without
 * this, adding a term would rewrite the CHECK list of a migration that already ran.
 */
export function termIdsAt(name, version) {
  return termIds(name).filter((id) => {
    const { since, until } = term(name, id) ?? {};
    return (!since || notAfter(since, version)) && (!until || notAfter(version, until));
  });
}

/** Term ids a row written today may carry: without the retired ones. */
export function currentTermIds(name) {
  return termIdsAt(name, schema.vocabularies[name].version ?? schema.version);
}

/** Term body, or an empty object for list-shaped vocabularies. */
export function term(name, id) {
  const terms = schema.vocabularies[name].terms;
  if (Array.isArray(terms)) return terms.includes(id) ? {} : undefined;
  return terms[id];
}

/** Columns a vocabulary governs, so a checker can compare CHECK lists. */
export const governedColumns = {
  "extracted_events.kind": "event_kind",
  "activity_evidence.evidence_tier": "evidence_tier",
  "activity_evidence.method": "relation_method",
  "activity_evidence.status": "relation_status",
  "activity_task_edges.method": "relation_method",
  "activity_task_edges.status": "relation_status",
  "activity_gate_edges.method": "relation_method",
  "activity_gate_edges.status": "relation_status",
  "market_occupation_edges.method": "relation_method",
  "market_occupation_edges.status": "relation_status",
  "gates.gate_type": "gate_type",
  "gates.lifecycle": "lifecycle",
  "source_accounts.panel_role": "panel_role",
  "source_accounts.panel_state": "panel_state",
  "source_accounts.identity_grade": "identity_evidence_grade",
  "person_affiliations.relation": "affiliation_relation",
  "source_account_checks.check_kind": "account_check_kind",
  "verification_evidence.post_nature": "post_nature",
  "verification_evidence.evidence_tier": "evidence_tier",
  "verification_evidence.status": "relation_status",
  "event_posts.link": "post_link",
  "judgment_runs.task": "judgment_task",
  "models.level": "model_level",
  "models.status": "model_status",
  "event_models.role": "model_role",
  "model_providers.kind": "provider_kind",
  "model_output_modalities.modality": "modality",
  "ontology_concepts.kind": "concept_kind",
  "ontology_relations.view": "concept_view",
  "source_accounts.owner_kind": "account_owner_kind",
  "source_accounts.language": "account_language",
  "extracted_events.occurrence_status": "occurrence_status",
  "extracted_events.identity_confidence": "identity_confidence",
  "extracted_events.basis": "event_basis",
  "extracted_events.result": "event_result",
  "extracted_event_sources.source_role": "source_role",
  "activity_evidence.evidence_sign": "evidence_sign",
  "topics.question_type": "topic_question_type",
  "topics.state": "topic_state",
  "topics.origin": "topic_origin",
  "topics.about_method": "relation_method",
  "topics.about_status": "relation_status",
  "event_measures.method": "relation_method",
  "event_measures.status": "relation_status",
  "topic_option_evidence.method": "relation_method",
  "topic_option_evidence.status": "relation_status",
  "topic_option_evidence.sign": "answer_evidence_sign",
};

const SQL_IDENT = /^[a-z][a-z0-9_]*$/;

/** Vocabularies whose term ids are numbers on a scale rather than tokens. */
const NUMERIC_TERMS = new Set(["autonomy_stage", "activity_level"]);

/** Fails loudly rather than projecting a malformed model into SQL or prompts. */
export function validateSchema(model = schema) {
  const problems = [];
  const add = (message) => problems.push(message);

  if (!/^\d+\.\d+\.\d+$/.test(model.version ?? "")) add(`version must be x.y.z, found ${model.version}`);
  if (!["review", "active"].includes(model.status)) add(`status must be review or active, found ${model.status}`);

  for (const name of Object.keys(model.vocabularies)) {
    if (!SQL_IDENT.test(name)) add(`vocabulary ${name} is not a usable SQL identifier`);
    let ids;
    try {
      ids = termIds(name);
    } catch (error) {
      add(error.message);
      continue;
    }
    if (ids.length === 0) add(`vocabulary ${name} is empty`);
    for (const id of ids) {
      // Both level scales use numeric ids; everything else must be a SQL-safe token.
      if (!NUMERIC_TERMS.has(name) && name !== "evidence_tier" && !SQL_IDENT.test(id)) {
        add(`term ${name}.${id} is not a usable SQL identifier`);
      }
      if (id === "other") add(`vocabulary ${name} still has an "other" bucket (rule:no-other-bucket)`);
      if (id.includes("'")) add(`term ${name}.${id} would break a SQL literal`);
    }
    if (new Set(ids).size !== ids.length) add(`vocabulary ${name} has duplicate terms`);
  }

  // event_kind is the vocabulary whose missing definitions caused the observed
  // drift, so it is held to a stricter shape than the rest.
  const shape = model.vocabularies.event_kind.term_shape ?? [];
  for (const id of termIds("event_kind")) {
    const body = term("event_kind", id);
    if (!body || typeof body !== "object") {
      add(`event_kind.${id} has no definition body`);
      continue;
    }
    for (const field of shape) {
      if (body[field] === undefined) add(`event_kind.${id} is missing ${field}`);
    }
  }

  for (const [id, body] of Object.entries(model.vocabularies.person_event_role.terms)) {
    const tier = body.implies_tier;
    if (!termIds("evidence_tier").includes(tier)) {
      add(`person_event_role.${id} implies unknown tier ${tier}`);
    }
  }

  // Each tier carries one cap per scale. They are NOT the same numbers - T2 caps
  // at 3 on the retired 0-4 stage scale and at 4 on the 0-5 level scale - and
  // only T3 agreeing at 2 in both is why the divergence went unnoticed while the
  // level caps lived in Python. Both are range-checked against their own scale.
  const levelIds = termIds("activity_level").map(Number);
  const topLevel = Math.max(...levelIds);
  for (const [id, body] of Object.entries(model.vocabularies.evidence_tier.terms)) {
    const stageCap = body.stage_cap;
    if (!Number.isInteger(stageCap) || stageCap < 0 || stageCap > 4) {
      add(`evidence_tier.${id} has an out-of-range stage_cap`);
    }
    const levelCap = body.level_cap;
    if (!Number.isInteger(levelCap) || levelCap < 0 || levelCap > topLevel) {
      add(`evidence_tier.${id} has an out-of-range level_cap (0-${topLevel})`);
    }
  }

  // The level scale is an ordered ladder: the ids ARE the values, and the judge is
  // shown them in this order, so a gap or a reorder silently changes every reading.
  const expectedLevels = levelIds.map((_, i) => i);
  if (levelIds.join() !== expectedLevels.join()) {
    add(`activity_level must be contiguous integers from 0, found ${levelIds.join(", ")}`);
  }
  for (const id of termIds("activity_level")) {
    const body = term("activity_level", id) ?? {};
    for (const field of ["label", "definition"]) {
      for (const language of ["en", "zh-CN"]) {
        if (!body[field]?.[language]) add(`activity_level.${id} is missing ${field}.${language}`);
      }
    }
  }
  const capped = model.vocabularies.activity_level.capped_by ?? {};
  if (capped.vocabulary !== "evidence_tier" || capped.field !== "level_cap") {
    add("activity_level must declare capped_by evidence_tier.level_cap (rule:tier-caps-level)");
  }

  // A property belongs to a declared class and points at a declared range.
  const DATATYPES = new Set(["string", "text", "boolean", "integer", "number", "date", "datetime", "uri", "object"]);
  const knownRange = (range) =>
    DATATYPES.has(range) ||
    (range.startsWith("vocabulary:") && range.slice(11) in model.vocabularies) ||
    (range.startsWith("class:") && range.slice(6) in model.classes) ||
    range.startsWith("external:");
  for (const [name, body] of Object.entries(model.classes)) {
    if (!/^[A-Z][A-Za-z]+$/.test(name)) add(`class ${name} is not an upper-camel singular name`);
    for (const field of ["label", "definition"]) {
      for (const language of ["en", "zh-CN"]) {
        if (!body[field]?.[language]) add(`class ${name} is missing ${field}.${language}`);
      }
    }
    if (body.subclass_of && !(body.subclass_of in model.classes)) add(`class ${name} extends unknown class ${body.subclass_of}`);
    const identifier = body.identifier ?? model.classes[body.subclass_of]?.identifier;
    const owner = body.identifier ? name : body.subclass_of;
    if (!identifier || !(`${owner}.${identifier}` in model.properties)) add(`class ${name} has no declared identifier property`);
  }
  for (const [key, body] of Object.entries(model.properties)) {
    const [domain, name] = key.split(".");
    if (domain !== body.domain || !(domain in model.classes)) add(`property ${key} does not belong to a declared class`);
    if (!name || !SQL_IDENT.test(name)) add(`property ${key} is not a usable identifier`);
    if (typeof body.range !== "string" || !knownRange(body.range)) add(`property ${key} has unknown range ${body.range}`);
    if (![0, 1].includes(body.min) || !(body.max === 1 || body.max === "*")) add(`property ${key} needs min 0|1 and max 1|*`);
    for (const language of ["en", "zh-CN"]) {
      if (!body.definition?.[language]) add(`property ${key} is missing definition.${language}`);
    }
  }
  const CARDINALITY = new Set(["1", "0..1", "0..*", "1..*"]);
  for (const [name, body] of Object.entries(model.relations)) {
    for (const end of [body.domain, body.range].flat()) {
      if (!(end in model.classes) && !String(end).startsWith("external:")) add(`relation ${name} points at unknown class ${end}`);
    }
    for (const side of ["domain_cardinality", "range_cardinality"]) {
      if (!CARDINALITY.has(body[side])) add(`relation ${name} has no valid ${side}`);
    }
    for (const [attribute, range] of Object.entries(body.attributes ?? {})) {
      if (!knownRange(range)) add(`relation ${name}.${attribute} has unknown range ${range}`);
    }
    if (!body.storage) add(`relation ${name} does not say where it is stored`);
  }
  const ids = model.constraints.map((constraint) => constraint.id);
  if (new Set(ids).size !== ids.length) add("constraint ids are not unique");

  // rule:blocked-by-needs-source-task retired with the capability layer: gates
  // now attach to activities directly (activity_gate_edges) and no longer have
  // to reach a gate claim through some task's text.
  for (const gate of gates.gates) {
    if (!termIds("gate_type").includes(gate.gate_type)) add(`gate ${gate.id} has unknown gate_type ${gate.gate_type}`);
    if (gate.status === "reviewed" && gate.method !== "reviewed") {
      add(`gate ${gate.id} claims reviewed status without a reviewed method`);
    }
  }

  return problems;
}

/** The same list as the vocabulary stood at one of its versions. */
export function sqlValueListAt(name, version) {
  return termIdsAt(name, version).map((id) => `'${id}'`).join(", ");
}

/** `'a', 'b', 'c'` for embedding in a generated CHECK constraint. */
export function sqlValueList(name) {
  return termIds(name).map((id) => `'${id}'`).join(", ");
}
