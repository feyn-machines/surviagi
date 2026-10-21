import Ajv2020 from "ajv/dist/2020.js";
import { ontologyCollections, ontologyModel, ontologySchema } from "./ontology-data-format.mjs";

const ajv = new Ajv2020({ allErrors: false });
ajv.addFormat("uri", (value) => {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
});
const checkSchema = ajv.compile(ontologySchema);
const fail = (message) => { throw new Error(message); };
const key = (...parts) => JSON.stringify(parts);
const pick = (row, fields) => Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));

function unique(rows, getKey, name) {
  const result = new Map();
  for (const row of rows) {
    const identity = getKey(row);
    if (result.has(identity)) fail(`duplicate ${name}: ${identity}`);
    result.set(identity, row);
  }
  return result;
}

function reference(index, id, name) {
  if (!index.has(id)) fail(`missing reference ${name}: ${id}`);
  return index.get(id);
}

function assertAcyclic(ids, children, label) {
  const active = new Set(), complete = new Set();
  const visit = (id) => {
    if (active.has(id)) fail(`${label} cycle: ${id}`);
    if (complete.has(id)) return;
    active.add(id);
    for (const child of children.get(id) ?? []) visit(child);
    active.delete(id); complete.add(id);
  };
  for (const id of ids) visit(id);
}

function addChild(children, parent, child) {
  if (!children.has(parent)) children.set(parent, []);
  children.get(parent).push(child);
}

function requiredSources(data) {
  const { onet, isic, editorial } = ontologyModel.source_systems;
  const ids = new Set(data.external_mappings.map((row) => row.source_id));
  if (data.concepts.some((row) => row.origin === "editorial_ai") || data.coverage.length) ids.add(editorial.source_id);
  if (data.concepts.some((row) => row.origin === "onet_projection") || ["reference_occupation_groups", "reference_occupations", "reference_tasks", "reference_activities", "reference_task_activity_links"].some((name) => data[name].length)) ids.add(onet.source_id);
  if (data.reference_taxonomy_codes.length || data.coverage.length) ids.add(isic.source_id);
  return ids;
}

/** Read-only extraction. The caller must verify the sealed legacy release before calling. */
export function projectOntology(legacyData) {
  const nodes = unique(legacyData.nodes, (row) => row.id, "legacy concept");
  const occupationCodes = unique(legacyData.reference_occupations, (row) => row.source_code, "legacy occupation code");
  const taskCodes = unique(legacyData.reference_tasks, (row) => row.source_task_id, "legacy task code");
  const sourceMappings = unique(legacyData.external_mappings.filter((row) => row.relation === "source_projection"), (row) => row.node_id, "legacy source projection");
  const concepts = legacyData.nodes.map((node) => {
    let definition = null;
    const mapping = sourceMappings.get(node.id);
    if (node.origin === "onet_projection" && mapping?.external_type === "onet_occupation") {
      const occupation = reference(occupationCodes, mapping.external_id, "occupation definition");
      definition = { text: occupation.description_en, language: "en", basis: "source_occupation_description" };
    } else if (node.origin === "onet_projection" && mapping?.external_type === "onet_task") {
      const task = reference(taskCodes, mapping.external_id, "task definition");
      definition = { text: task.statement_en, language: "en", basis: "source_task_statement" };
    } else if (node.origin === "editorial_ai" && node.scope_note) {
      definition = { text: node.scope_note, language: /\p{Script=Han}/u.test(node.scope_note) ? "zh-CN" : "en", basis: "editorial_scope_note" };
    }
    return { ...pick(node, ["id", "kind", "label_zh_cn", "label_en", "origin", "translation_status", "scope_status", "scope_note"]), definition };
  });
  const relations = legacyData.relations.map((relation) => {
    const parent = reference(nodes, relation.parent_id, "relation parent");
    const child = reference(nodes, relation.child_id, "relation child");
    const match = Object.entries(ontologyModel.relationship_kinds).find(([, rule]) => rule.view === relation.view && rule.parent_kind === parent.kind && rule.child_kind === child.kind);
    if (!match) fail(`unsupported relation endpoint/view: ${relation.id}`);
    return { ...pick(relation, ["id", "view", "parent_id", "child_id", "order"]), kind: match[0] };
  });
  const sourceVersion = ontologyModel.source_systems.onet.version;
  const data = {
    concepts,
    relations,
    external_mappings: legacyData.external_mappings.map((row) => ({ ...pick(row, ["id", "source_id", "external_type", "external_id", "relation", "method", "status", "explanation"]), concept_id: row.node_id })),
    sources: [],
    reference_occupation_groups: legacyData.external_mappings.filter((row) => row.external_type === "onet_family" && row.relation === "source_projection").map((row) => ({
      id: `onet-family:${row.external_id}`, source_code: row.external_id, label_en: reference(nodes, row.node_id, "source occupation group").label_en, source_version: sourceVersion,
    })),
    reference_occupations: legacyData.reference_occupations.map((row) => pick(row, ["id", "source_code", "family_id", "label_en", "description_en", "source_version", "source_url"])),
    reference_tasks: legacyData.reference_tasks.map((row) => pick(row, ["id", "source_task_id", "occupation_id", "statement_en", "task_type", "source_version"])),
    reference_activities: legacyData.reference_activities.map((row) => pick(row, ["id", "source_id", "kind", "label_en", "parent_id"])),
    reference_task_activity_links: legacyData.reference_task_activity_links.map((row) => pick(row, ["task_id", "activity_id", "source_updated_month", "domain_source"])),
    reference_taxonomy_codes: legacyData.reference_taxonomy_codes.map((row) => pick(row, ["id", "source_code", "kind", "parent_id"])),
    coverage: legacyData.coverage.map((row) => ({ ...pick(row, ["isic_section", "coverage_note"]), domain_ids: [...row.domain_ids] })),
  };
  const needed = requiredSources(data);
  data.sources = legacyData.sources.filter((row) => needed.has(row.id)).map((row) => {
    const source = pick(row, ["id", "version", "url", "license", "status", "note"]);
    const rule = Object.values(ontologyModel.source_systems).find((system) => system.source_id === source.id);
    if (rule?.export_note) source.note = rule.export_note;
    return source;
  });
  validateOntology(data);
  return data;
}

export function validateOntology(data) {
  if (!checkSchema(data)) fail(`schema: ${ajv.errorsText(checkSchema.errors)}`);
  const by = {};
  for (const name of ontologyCollections.filter((name) => !["reference_task_activity_links", "coverage"].includes(name))) by[name] = unique(data[name], (row) => row.id, name);
  unique(data.relations, (row) => key(row.view, row.parent_id, row.child_id), "relation edge");
  unique(data.relations, (row) => key(row.view, row.parent_id, row.order), "relation sibling order");
  const children = new Map();
  for (const relation of data.relations) {
    const parent = reference(by.concepts, relation.parent_id, "relation parent");
    const child = reference(by.concepts, relation.child_id, "relation child");
    const rule = ontologyModel.relationship_kinds[relation.kind];
    if (rule.view !== relation.view || rule.parent_kind !== parent.kind || rule.child_kind !== child.kind) fail(`relation endpoint/view mismatch: ${relation.id}`);
    addChild(children, key(relation.view, parent.id), key(relation.view, child.id));
  }
  assertAcyclic(children.keys(), children, "classification");

  const codes = {};
  for (const [type, rule] of Object.entries(ontologyModel.external_types)) {
    // All taxonomy codes are checked for uniqueness, including non-section levels.
    const allCodes = unique(data[rule.collection], (row) => row[rule.code_field], `${rule.collection} code`);
    codes[type] = rule.reference_kind ? new Map([...allCodes].filter(([, row]) => row.kind === rule.reference_kind)) : allCodes;
  }
  for (const row of data.reference_occupations) reference(by.reference_occupation_groups, row.family_id, "occupation family");
  for (const row of data.reference_tasks) reference(by.reference_occupations, row.occupation_id, "task occupation");
  for (const [name, levels] of Object.entries(ontologyModel.reference_hierarchies)) {
    const childIndex = new Map();
    for (const row of data[name]) if (row.parent_id !== null) {
      reference(by[name], row.parent_id, `${name} parent`);
      addChild(childIndex, row.parent_id, row.id);
    }
    assertAcyclic(by[name].keys(), childIndex, name);
    for (const row of data[name]) {
      const expectedParent = levels[row.kind];
      if (expectedParent === null ? row.parent_id !== null : row.parent_id === null || by[name].get(row.parent_id).kind !== expectedParent) fail(`${name} hierarchy parent kind mismatch: ${row.id}`);
    }
  }
  unique(data.reference_task_activity_links, (row) => key(row.task_id, row.activity_id), "task activity link");
  for (const row of data.reference_task_activity_links) {
    reference(by.reference_tasks, row.task_id, "task activity task");
    const activity = reference(by.reference_activities, row.activity_id, "task activity activity");
    if (activity.kind !== "DWA") fail(`task activity reference must be DWA: ${row.activity_id}`);
  }

  const knownSources = new Map(Object.values(ontologyModel.source_systems).map((source) => [source.source_id, source]));
  const needed = requiredSources(data);
  for (const source of data.sources) {
    const rule = reference(knownSources, source.id, "ontology source");
    if (!needed.has(source.id)) fail(`unused ontology source: ${source.id}`);
    if (source.version !== rule.version) fail(`source version mismatch: ${source.id}`);
    const expectedStatus = source.id === ontologyModel.source_systems.editorial.source_id ? "editorial_draft" : "reference";
    if (source.status !== expectedStatus) fail(`source status mismatch: ${source.id}`);
  }
  for (const id of needed) reference(by.sources, id, "required ontology source");
  for (const name of ["reference_occupation_groups", "reference_occupations", "reference_tasks"]) for (const row of data[name]) {
    if (row.source_version !== ontologyModel.source_systems.onet.version) fail(`reference source version mismatch: ${row.id}`);
  }
  unique(data.external_mappings, (row) => key(row.concept_id, row.source_id, row.external_type, row.external_id, row.relation), "external mapping");
  const sourceProjections = new Map();
  for (const mapping of data.external_mappings) {
    const concept = reference(by.concepts, mapping.concept_id, "mapping concept");
    reference(by.sources, mapping.source_id, "mapping source");
    const rule = ontologyModel.external_types[mapping.external_type];
    if (mapping.source_id !== ontologyModel.source_systems[rule.source_system].source_id) fail(`mapping source system mismatch: ${mapping.id}`);
    const external = reference(codes[mapping.external_type], mapping.external_id, "mapping external code");
    if (mapping.method === "ai_proposed") {
      if (mapping.status !== "candidate") fail(`AI mapping must remain candidate: ${mapping.id}`);
      if (["exact", "source_projection"].includes(mapping.relation)) fail(`AI candidate cannot assert equivalence/source projection: ${mapping.id}`);
    }
    if (mapping.relation === "exact" && (mapping.method !== "reviewed" || mapping.status !== "reviewed")) fail(`exact equivalence requires reviewed mapping: ${mapping.id}`);
    if (mapping.status === "reviewed" && mapping.method !== "reviewed") fail(`reviewed mapping requires reviewed method: ${mapping.id}`);
    if (mapping.method === "reviewed" && mapping.status !== "reviewed") fail(`reviewed method requires reviewed status: ${mapping.id}`);
    if (mapping.relation === "source_projection") {
      if (mapping.method !== "source_id" || mapping.status !== "source_reference" || concept.origin !== "onet_projection" || concept.kind !== rule.projection_kind) fail(`invalid source projection: ${mapping.id}`);
      if (sourceProjections.has(concept.id)) fail(`duplicate source projection for concept: ${concept.id}`);
      sourceProjections.set(concept.id, { mapping, external });
    } else if (mapping.status === "source_reference" || mapping.method === "source_id") fail(`source reference must be a source projection: ${mapping.id}`);
  }
  for (const concept of data.concepts) {
    const projected = sourceProjections.get(concept.id);
    if (concept.origin === "onet_projection" && !projected) fail(`missing source projection for concept: ${concept.id}`);
    const definition = concept.definition;
    if (definition === null) {
      if (["onet_occupation", "onet_task"].includes(projected?.mapping.external_type)) fail(`available native source definition must be retained: ${concept.id}`);
      continue;
    }
    let expectedText, expectedLanguage;
    if (definition.basis === "editorial_scope_note" && concept.origin === "editorial_ai") {
      expectedText = concept.scope_note;
      expectedLanguage = expectedText && /\p{Script=Han}/u.test(expectedText) ? "zh-CN" : "en";
    } else if (definition.basis === "source_occupation_description" && projected?.mapping.external_type === "onet_occupation") {
      expectedText = projected.external.description_en; expectedLanguage = "en";
    } else if (definition.basis === "source_task_statement" && projected?.mapping.external_type === "onet_task") {
      expectedText = projected.external.statement_en; expectedLanguage = "en";
    }
    if (definition.text !== expectedText || definition.language !== expectedLanguage) fail(`definition does not match existing source/scope: ${concept.id}`);
  }

  // Retain each projected record's original membership while allowing additional
  // typed associations and shared work across parents and views.
  const sourceMembership = new Set();
  for (const relation of data.relations) {
    const parent = sourceProjections.get(relation.parent_id), child = sourceProjections.get(relation.child_id);
    if (parent && child) sourceMembership.add(key(relation.kind, parent.external.id, child.external.id));
  }
  for (const { mapping, external } of sourceProjections.values()) {
    if (mapping.external_type === "onet_occupation" && !sourceMembership.has(key("has_occupation", external.family_id, external.id))) fail(`source occupation family membership missing: ${mapping.concept_id}`);
    if (mapping.external_type === "onet_task" && !sourceMembership.has(key("has_task", external.occupation_id, external.id))) fail(`source task occupation membership missing: ${mapping.concept_id}`);
  }
  unique(data.coverage, (row) => row.isic_section, "coverage section");
  const mappedCoverage = new Set(data.external_mappings.filter((mapping) => mapping.external_type === "isic_section" && by.concepts.get(mapping.concept_id).kind === "market_group").map((mapping) => key(mapping.external_id, mapping.concept_id)));
  const declaredCoverage = new Set();
  for (const row of data.coverage) {
    reference(codes.isic_section, row.isic_section, "coverage section");
    for (const id of row.domain_ids) {
      if (reference(by.concepts, id, "coverage domain").kind !== "market_group") fail(`coverage domain must be market_group: ${id}`);
      const pair = key(row.isic_section, id);
      if (!mappedCoverage.has(pair)) fail(`coverage domain lacks matching ISIC mapping: ${pair}`);
      declaredCoverage.add(pair);
    }
  }
  for (const pair of mappedCoverage) if (!declaredCoverage.has(pair)) fail(`ISIC-mapped domain is missing from coverage: ${pair}`);
  return { counts: Object.fromEntries(ontologyCollections.map((name) => [name, data[name].length])) };
}
