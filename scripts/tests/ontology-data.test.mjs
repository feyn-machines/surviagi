import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectOntology, validateOntology } from "../lib/ontology-data.mjs";
import { ontologyCollections, ontologyModel, ontologySchema } from "../lib/ontology-data-format.mjs";
import { verifyRelease } from "../lib/platform-data.mjs";
import { collections as legacyCollections } from "../lib/platform-schema.mjs";

// Literal examples deliberately do not derive expectations from the schema or projector.
function fixture() {
  return {
    concepts: [
      { id: "domain", kind: "market_group", label_zh_cn: "领域", label_en: "Domain", origin: "editorial_ai", translation_status: "ai_translated", scope_status: "starter_catalog", scope_note: "已有编辑范围。", definition: { text: "已有编辑范围。", language: "zh-CN", basis: "editorial_scope_note" } },
      { id: "market-a", kind: "market", label_zh_cn: "赛道甲", label_en: "Market A", origin: "editorial_ai", translation_status: "ai_translated", scope_status: "defined", definition: null },
      { id: "market-b", kind: "market", label_zh_cn: "赛道乙", label_en: "Market B", origin: "editorial_ai", translation_status: "ai_translated", scope_status: "defined", definition: null },
      { id: "family", kind: "occupation_group", label_zh_cn: "管理", label_en: "Management", origin: "onet_projection", translation_status: "ai_translated", scope_status: "defined", definition: null },
      { id: "occupation", kind: "occupation", label_zh_cn: "主管", label_en: "Chief Executives", origin: "onet_projection", translation_status: "ai_translated", scope_status: "defined", definition: { text: "Direct an organization.", language: "en", basis: "source_occupation_description" } },
      { id: "shared-work", kind: "work", label_zh_cn: null, label_en: "Prepare budgets.", origin: "onet_projection", translation_status: "pending", scope_status: "defined", definition: { text: "Prepare budgets.", language: "en", basis: "source_task_statement" } },
      { id: "custom-work", kind: "work", label_zh_cn: "编制预算", label_en: "Prepare budgets.", origin: "editorial_ai", translation_status: "ai_translated", scope_status: "defined", definition: null },
    ],
    relations: [
      { id: "r-domain-a", kind: "has_market", view: "markets", parent_id: "domain", child_id: "market-a", order: 0 },
      { id: "r-domain-b", kind: "has_market", view: "markets", parent_id: "domain", child_id: "market-b", order: 1 },
      { id: "r-a-shared", kind: "has_work", view: "markets", parent_id: "market-a", child_id: "shared-work", order: 0 },
      { id: "r-b-shared", kind: "has_work", view: "markets", parent_id: "market-b", child_id: "shared-work", order: 0 },
      { id: "r-a-custom", kind: "has_work", view: "markets", parent_id: "market-a", child_id: "custom-work", order: 1 },
      { id: "r-family", kind: "has_occupation", view: "occupations", parent_id: "family", child_id: "occupation", order: 0 },
      { id: "r-task", kind: "has_task", view: "occupations", parent_id: "occupation", child_id: "shared-work", order: 0 },
    ],
    external_mappings: [
      { id: "m-family", concept_id: "family", source_id: "onet-31.0", external_type: "onet_family", external_id: "11", relation: "source_projection", method: "source_id", status: "source_reference" },
      { id: "m-occupation", concept_id: "occupation", source_id: "onet-31.0", external_type: "onet_occupation", external_id: "11-1011.00", relation: "source_projection", method: "source_id", status: "source_reference" },
      { id: "m-task", concept_id: "shared-work", source_id: "onet-31.0", external_type: "onet_task", external_id: "8827", relation: "source_projection", method: "source_id", status: "source_reference" },
      { id: "m-isic", concept_id: "domain", source_id: "isic-rev5", external_type: "isic_section", external_id: "A", relation: "related", method: "ai_proposed", status: "candidate", explanation: "Existing draft association." },
    ],
    sources: [
      { id: "onet-31.0", version: "31.0", url: "https://www.onetcenter.org/database.html", license: "CC-BY-4.0", status: "reference", note: "O*NET 31.0 occupation, task and activity references. Chinese occupation labels are openaiwill AI adaptations, not official translations. This ontology export excludes weights, IM/RT ratings, frequency distributions, sample sizes and task counts; original source notes remain in platform 0.0.1." },
      { id: "isic-rev5", version: "5", url: "https://unstats.un.org/unsd/classifications/Econ/isic", license: "redistribution_not_confirmed_code_references_only", status: "reference" },
      { id: "openaiwill-editorial", version: "0.0.1", url: "https://openaiwill.com", license: "project_owned_draft", status: "editorial_draft", note: "Existing AI-proposed market catalog and scope notes; associations remain candidates. This ontology export contains no weights, capability baseline or progress values." },
    ],
    reference_occupation_groups: [{ id: "onet-family:11", source_code: "11", label_en: "Management", source_version: "31.0" }],
    reference_occupations: [{ id: "onet-occupation:11-1011.00", source_code: "11-1011.00", family_id: "onet-family:11", label_en: "Chief Executives", description_en: "Direct an organization.", source_version: "31.0", source_url: "https://www.onetonline.org/link/summary/11-1011.00" }],
    reference_tasks: [{ id: "onet-task:8827", source_task_id: "8827", occupation_id: "onet-occupation:11-1011.00", statement_en: "Prepare budgets.", task_type: "Core", source_version: "31.0" }],
    reference_activities: [
      { id: "gwa", source_id: "4.A.1", kind: "GWA", label_en: "Get information", parent_id: null },
      { id: "iwa", source_id: "4.A.1.a", kind: "IWA", label_en: "Study information", parent_id: "gwa" },
      { id: "dwa", source_id: "4.A.1.a.1", kind: "DWA", label_en: "Review budgets", parent_id: "iwa" },
    ],
    reference_task_activity_links: [{ task_id: "onet-task:8827", activity_id: "dwa", source_updated_month: "08/2023", domain_source: "Incumbent" }],
    reference_taxonomy_codes: [
      { id: "isic5:A", source_code: "A", kind: "section", parent_id: null },
      { id: "isic5:01", source_code: "01", kind: "division", parent_id: "isic5:A" },
      { id: "isic5:011", source_code: "011", kind: "group", parent_id: "isic5:01" },
      { id: "isic5:0111", source_code: "0111", kind: "class", parent_id: "isic5:011" },
    ],
    coverage: [{ isic_section: "A", domain_ids: ["domain"], coverage_note: "Existing editorial scope." }],
  };
}

function omitField(row, name) {
  const copy = structuredClone(row);
  delete copy[name];
  return copy;
}

function legacyFixture() {
  const data = fixture();
  data.sources[0].note = "Chinese occupation labels and normalized weights are adaptations; low-precision IM/RT values withheld.";
  data.sources[2].note = "AI-proposed market categories and sibling weights.";
  return {
    nodes: data.concepts.map((node) => omitField(node, "definition")),
    relations: data.relations.map((relation) => omitField(relation, "kind")),
    external_mappings: data.external_mappings.map(({ concept_id, ...mapping }) => ({ ...mapping, node_id: concept_id })),
    sources: [...data.sources, { id: "bls-ep-2025-35", version: "2025-35", url: "https://www.bls.gov/emp/", license: "US-government-data", status: "raw_not_integrated" }],
    reference_occupations: data.reference_occupations.map((row) => ({ ...row, source_task_count: 1 })),
    reference_tasks: data.reference_tasks.map((row) => ({ ...row, incumbents_responding: 10, importance: { value: 4.3, n: 10, suppress: false }, relevance: { value: 90, n: 10, suppress: false }, frequency: { 1: 25 }, source_updated_month: "08/2023", domain_source: "Incumbent", record_kind: "source_work_task_not_validated_delivery_scenario" })),
    reference_activities: data.reference_activities,
    reference_task_activity_links: data.reference_task_activity_links,
    reference_taxonomy_codes: data.reference_taxonomy_codes,
    coverage: data.coverage,
    weights: [{ relation_id: "r-a-shared", value: 1 }],
    metric_definitions: [{ id: "likes" }], events: [{ id: "event" }], observations: [{ value: 10 }], progress: [{ value: null }], progress_updates: [{ new_value: 12 }],
  };
}

test("the projection preserves identity and existing definitions, without inferring equivalence from matching labels", () => {
  const legacy = legacyFixture();
  const snapshot = structuredClone(legacy);
  const data = projectOntology(legacy);
  assert.deepEqual(data, fixture());
  assert.deepEqual(legacy, snapshot);
  data.reference_activities[0].label_en = "Changed export";
  data.coverage[0].domain_ids.push("another domain");
  assert.deepEqual(legacy, snapshot, "the projection must not share mutable arrays or rows with its input");
});

test("shared work is valid under multiple markets and the occupation view", () => {
  const { counts } = validateOntology(fixture());
  assert.equal(counts.concepts, 7);
  assert.equal(counts.relations, 7);
  assert.equal(counts.reference_occupation_groups, 1);
  assert.equal(ontologyModel.version, "1.0.0");
  assert.equal(ontologySchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(ontologyCollections.length, 11);
});

test("retaining a source task's native occupation does not forbid association with another occupation", () => {
  const data = fixture();
  data.concepts.push({ id: "occupation-2", kind: "occupation", label_zh_cn: null, label_en: "General Managers", origin: "onet_projection", translation_status: "source_original", scope_status: "defined", definition: { text: "Manage operations.", language: "en", basis: "source_occupation_description" } });
  data.reference_occupations.push({ id: "onet-occupation:11-1021.00", source_code: "11-1021.00", family_id: "onet-family:11", label_en: "General Managers", description_en: "Manage operations.", source_version: "31.0", source_url: "https://www.onetonline.org/link/summary/11-1021.00" });
  data.external_mappings.push({ id: "m-occupation-2", concept_id: "occupation-2", source_id: "onet-31.0", external_type: "onet_occupation", external_id: "11-1021.00", relation: "source_projection", method: "source_id", status: "source_reference" });
  data.relations.push({ id: "r-family-2", kind: "has_occupation", view: "occupations", parent_id: "family", child_id: "occupation-2", order: 1 });
  data.relations.push({ id: "r-task-2", kind: "has_task", view: "occupations", parent_id: "occupation-2", child_id: "shared-work", order: 0 });
  assert.equal(validateOntology(data).counts.relations, 9);
});

const badRelations = [
  ["wrong view", { view: "occupations" }],
  ["wrong kind", { kind: "has_task" }],
  ["wrong parent kind", { parent_id: "shared-work" }],
  ["wrong child kind", { child_id: "occupation" }],
  ["missing parent", { parent_id: "absent" }],
  ["missing child", { child_id: "absent" }],
  ["self link", { child_id: "domain" }],
];
for (const [name, change] of badRelations) test(`rejects a relation with ${name}`, () => {
  const data = fixture();
  Object.assign(data.relations[0], change);
  assert.throws(() => validateOntology(data), /relation|reference|cycle|endpoint/i);
});

for (const [name, mutate] of [
  ["runtime collection", (d) => { d.progress = []; }],
  ["metric field", (d) => { d.concepts[0].completion = 0; }],
  ["relation weight", (d) => { d.relations[0].weight = 1; }],
  ["task importance", (d) => { d.reference_tasks[0].importance = null; }],
  ["task frequency", (d) => { d.reference_tasks[0].frequency = {}; }],
  ["task sample size", (d) => { d.reference_tasks[0].incumbents_responding = 0; }],
  ["occupation task count", (d) => { d.reference_occupations[0].source_task_count = 1; }],
  ["invented nested definition field", (d) => { d.concepts[0].definition.confidence = 1; }],
  ["legacy mapping node_id", (d) => { d.external_mappings[0].node_id = "family"; }],
  ["negative order", (d) => { d.relations[0].order = -1; }],
  ["invalid URI", (d) => { d.sources[0].url = "not a URI"; }],
  ["missing required collection", (d) => { delete d.reference_tasks; }],
]) test(`closed schema rejects ${name}`, () => {
  const data = fixture(); mutate(data);
  assert.throws(() => validateOntology(data), /schema/i);
});

for (const collection of ["concepts", "relations", "external_mappings", "sources", "reference_occupation_groups", "reference_occupations", "reference_tasks", "reference_activities", "reference_taxonomy_codes", "reference_task_activity_links", "coverage"]) test(`rejects duplicate identity in ${collection}`, () => {
  const data = fixture(); data[collection].push(structuredClone(data[collection][0]));
  assert.throws(() => validateOntology(data), /duplicate/i);
});

for (const [name, mutate] of [
  ["edge under another ID", (d) => { d.relations.push({ ...d.relations[0], id: "another-edge", order: 99 }); }],
  ["sibling order", (d) => { d.relations[1].order = 0; }],
  ["mapping under another ID", (d) => { d.external_mappings.push({ ...d.external_mappings[0], id: "another-mapping" }); }],
  ["occupation code", (d) => { d.reference_occupations.push({ ...d.reference_occupations[0], id: "another-occupation" }); }],
  ["task code", (d) => { d.reference_tasks.push({ ...d.reference_tasks[0], id: "another-task" }); }],
  ["group code", (d) => { d.reference_occupation_groups.push({ ...d.reference_occupation_groups[0], id: "another-family" }); }],
  ["activity code", (d) => { d.reference_activities.push({ ...d.reference_activities[0], id: "another-activity" }); }],
  ["taxonomy code", (d) => { d.reference_taxonomy_codes.push({ ...d.reference_taxonomy_codes[0], id: "another-taxonomy" }); }],
]) test(`rejects duplicate ${name}`, () => {
  const data = fixture(); mutate(data);
  assert.throws(() => validateOntology(data), /duplicate/i);
});

for (const [name, mutate] of [
  ["mapping concept", (d) => { d.external_mappings[0].concept_id = "missing"; }],
  ["mapping source", (d) => { d.external_mappings[0].source_id = "missing"; }],
  ["mapping external code", (d) => { d.external_mappings[0].external_id = "99"; }],
  ["occupation family", (d) => { d.reference_occupations[0].family_id = "missing"; }],
  ["task occupation", (d) => { d.reference_tasks[0].occupation_id = "missing"; }],
  ["activity parent", (d) => { d.reference_activities[1].parent_id = "missing"; }],
  ["taxonomy parent", (d) => { d.reference_taxonomy_codes[1].parent_id = "missing"; }],
  ["task link task", (d) => { d.reference_task_activity_links[0].task_id = "missing"; }],
  ["task link activity", (d) => { d.reference_task_activity_links[0].activity_id = "missing"; }],
  ["coverage section", (d) => { d.coverage[0].isic_section = "Z"; }],
  ["coverage domain", (d) => { d.coverage[0].domain_ids = ["missing"]; }],
]) test(`rejects dangling ${name}`, () => {
  const data = fixture(); mutate(data);
  assert.throws(() => validateOntology(data), /reference|source/i);
});

for (const collection of ["reference_activities", "reference_taxonomy_codes"]) {
  test(`rejects a cycle in ${collection}`, () => {
    const data = fixture(); data[collection][0].parent_id = data[collection][1].id;
    assert.throws(() => validateOntology(data), /cycle/i);
  });
  test(`rejects a child assigned to the wrong level in ${collection}`, () => {
    const data = fixture(); data[collection][2].parent_id = data[collection][0].id;
    assert.throws(() => validateOntology(data), /hierarchy|parent kind/i);
  });
}

for (const [name, mutate] of [
  ["AI mapping marked reviewed", (d) => { d.external_mappings[3].status = "reviewed"; }],
  ["AI mapping asserted as exact equivalence", (d) => { d.external_mappings[3].relation = "exact"; }],
  ["O*NET code attached to ISIC source", (d) => { d.external_mappings[0].source_id = "isic-rev5"; }],
  ["source version mismatch", (d) => { d.sources[0].version = "30.0"; }],
  ["reference version mismatch", (d) => { d.reference_tasks[0].source_version = "30.0"; }],
  ["unrelated source", (d) => { d.sources.push({ id: "unused", version: "1", url: "https://example.com", license: "unknown", status: "reference" }); }],
  ["missing editorial source", (d) => { d.sources.pop(); }],
  ["source projection to the wrong concept kind", (d) => { d.external_mappings[0].concept_id = "custom-work"; }],
  ["invented source definition", (d) => { d.concepts[4].definition.text = "Invented explanation."; }],
  ["discarded occupation source definition", (d) => { d.concepts[4].definition = null; }],
  ["discarded task source definition", (d) => { d.concepts[5].definition = null; }],
  ["source task assigned to another source occupation", (d) => {
    d.reference_occupations.push({ ...d.reference_occupations[0], id: "occupation-2", source_code: "11-1021.00" });
    d.reference_tasks[0].occupation_id = "occupation-2";
  }],
  ["coverage on work rather than a domain", (d) => { d.coverage[0].domain_ids = ["custom-work"]; }],
]) test(`rejects ${name}`, () => {
  const data = fixture(); mutate(data);
  assert.throws(() => validateOntology(data), /candidate|equivalence|source|version|definition|projection|occupation|market_group/i);
});

test("coverage cannot claim an ISIC association without a matching domain mapping", () => {
  const data = fixture();
  data.external_mappings = data.external_mappings.filter((mapping) => mapping.id !== "m-isic");
  assert.throws(() => validateOntology(data), /coverage.*mapping|mapping.*coverage/i);
});

test("an ISIC-mapped domain must also appear in coverage", () => {
  const data = fixture(); data.coverage = [];
  assert.throws(() => validateOntology(data), /coverage/i);
});

test("coverage and mapping consistency is checked for each domain within a section", () => {
  const data = fixture();
  data.concepts.push({ id: "domain-2", kind: "market_group", label_zh_cn: null, label_en: "Another domain", origin: "editorial_ai", translation_status: "source_original", scope_status: "starter_catalog", definition: null });
  data.coverage[0].domain_ids.push("domain-2");
  assert.throws(() => validateOntology(data), /coverage.*mapping|mapping.*coverage/i);
  data.external_mappings.push({ id: "m-isic-2", concept_id: "domain-2", source_id: "isic-rev5", external_type: "isic_section", external_id: "A", relation: "related", method: "ai_proposed", status: "candidate" });
  assert.doesNotThrow(() => validateOntology(data));
  data.coverage[0].domain_ids.pop();
  assert.throws(() => validateOntology(data), /coverage/i);
});

test("an unsupported legacy edge fails projection instead of being silently relabelled", () => {
  const data = legacyFixture(); data.relations[0].child_id = "occupation";
  assert.throws(() => projectOntology(data), /relation|endpoint/i);
});

test("the full verified v0.0.1 catalog projects without rewriting IDs or input data", async () => {
  const dir = fileURLToPath(new URL("../../datasets/platform/releases/v0.0.1/", import.meta.url));
  await verifyRelease(dir);
  const legacy = Object.fromEntries(await Promise.all(legacyCollections.map(async (name) => {
    const content = await readFile(join(dir, `${name}.jsonl`), "utf8");
    return [name, content.trim() ? content.trim().split("\n").map(JSON.parse) : []];
  })));
  const before = JSON.stringify(legacy);
  const data = projectOntology(legacy);
  const { counts } = validateOntology(data);
  assert.equal(counts.concepts, 20796);
  assert.equal(counts.relations, 20733);
  assert.equal(counts.reference_occupation_groups, 23);
  assert.equal(counts.reference_occupations, 1016);
  assert.equal(counts.reference_tasks, 18838);
  assert.equal(counts.reference_activities, 2460);
  assert.equal(counts.reference_taxonomy_codes, 830);
  assert.deepEqual(data.concepts.map((c) => c.id), legacy.nodes.map((n) => n.id));
  assert.deepEqual(data.relations.map((r) => r.id), legacy.relations.map((r) => r.id));
  assert.deepEqual(data.concepts.map((concept) => omitField(concept, "definition")), legacy.nodes);
  assert.deepEqual(data.relations.map((relation) => omitField(relation, "kind")), legacy.relations);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(data.sources.length, 3);
  assert.deepEqual(Object.fromEntries(["market_group", "market", "work", "occupation_group", "occupation"].map((kind) => [kind, data.concepts.filter((c) => c.kind === kind).length])), { market_group: 40, market: 265, work: 19452, occupation_group: 23, occupation: 1016 });
});
