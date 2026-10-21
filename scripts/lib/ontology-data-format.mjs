const str = { type: "string", minLength: 1 };
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const enumeration = (...values) => ({ enum: values });
const array = (items) => ({ type: "array", items });
const object = (properties, optional = []) => ({
  type: "object", properties,
  required: Object.keys(properties).filter((name) => !optional.includes(name)),
  additionalProperties: false,
});
const uri = { type: "string", format: "uri" };

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
}

// This is also serialized as model.json. Endpoint and view rules have one owner.
export const ontologyModel = freeze({
  name: "openaiwill ontology",
  version: "1.0.0",
  concept_kinds: {
    market_group: { description: "An editorial domain organizing related markets; not an industry weight or capability score." },
    market: { description: "An editorial market or service area grouping work that serves a related production or service need." },
    work: { description: "A named scope of work, either an editorial work item or a source occupation task; matching labels do not establish identity." },
    occupation_group: { description: "An O*NET occupation family used to organize source occupations." },
    occupation: { description: "An O*NET occupation with its source identity and occupational description." },
  },
  relationship_kinds: {
    has_market: { parent_kind: "market_group", child_kind: "market", view: "markets", description: "Organizes a market within an editorial domain." },
    has_work: { parent_kind: "market", child_kind: "work", view: "markets", description: "Associates a work item with a market." },
    has_occupation: { parent_kind: "occupation_group", child_kind: "occupation", view: "occupations", description: "Organizes an occupation within an occupation family." },
    has_task: { parent_kind: "occupation", child_kind: "work", view: "occupations", description: "Associates work with an occupation; source task membership is retained." },
  },
  relationship_semantics: {
    inheritance: false,
    multiple_parents: true,
    shared_work_across_views: true,
    views_are_additive: false,
    note: "These are organization and association relations, not is_a inheritance. Shared labels do not merge editorial work and source tasks.",
  },
  definition_bases: {
    source_occupation_description: "The existing English description of the mapped O*NET occupation, copied without new interpretation.",
    source_task_statement: "The existing English statement of the mapped O*NET task, copied without new interpretation.",
    editorial_scope_note: "An existing editorial scope note, retaining its editorial status.",
  },
  source_systems: {
    onet: { source_id: "onet-31.0", version: "31.0", description: "O*NET 31.0 occupation, family, task and activity reference data; a United States occupational reference.", export_note: "O*NET 31.0 occupation, task and activity references. Chinese occupation labels are openaiwill AI adaptations, not official translations. This ontology export excludes weights, IM/RT ratings, frequency distributions, sample sizes and task counts; original source notes remain in platform 0.0.1." },
    isic: { source_id: "isic-rev5", version: "5", description: "ISIC Revision 5 code hierarchy only; original descriptions are not redistributed." },
    editorial: { source_id: "openaiwill-editorial", version: "0.0.1", description: "The existing openaiwill editorial catalog; AI proposals remain drafts.", export_note: "Existing AI-proposed market catalog and scope notes; associations remain candidates. This ontology export contains no weights, capability baseline or progress values." },
  },
  external_types: {
    onet_family: { source_system: "onet", collection: "reference_occupation_groups", code_field: "source_code", projection_kind: "occupation_group" },
    onet_occupation: { source_system: "onet", collection: "reference_occupations", code_field: "source_code", projection_kind: "occupation" },
    onet_task: { source_system: "onet", collection: "reference_tasks", code_field: "source_task_id", projection_kind: "work" },
    onet_activity: { source_system: "onet", collection: "reference_activities", code_field: "source_id", projection_kind: null },
    isic_section: { source_system: "isic", collection: "reference_taxonomy_codes", code_field: "source_code", projection_kind: null, reference_kind: "section" },
  },
  reference_hierarchies: {
    reference_activities: { GWA: null, IWA: "GWA", DWA: "IWA" },
    reference_taxonomy_codes: { section: null, division: "section", group: "division", class: "group" },
  },
  limitations: [
    "Version 1.0.0 identifies the separated ontology contract, not semantic completeness or production deployment.",
    "O*NET is a United States reference; Chinese occupation labels are AI translations and task translations remain pending.",
    "Definitions are null when no existing occupation description, task statement or editorial scope note is available.",
    "AI-proposed mappings remain candidates and do not assert verified equivalence.",
    "Weights, events, metrics, observations, progress and task statistics are outside this contract.",
  ],
});

const rowSchemas = {
  concepts: object({
    id: str, kind: enumeration(...Object.keys(ontologyModel.concept_kinds)), label_zh_cn: nullable(str), label_en: str,
    origin: enumeration("editorial_ai", "onet_projection"), translation_status: enumeration("ai_translated", "pending", "source_original"),
    scope_status: enumeration("starter_catalog", "defined", "source_missing_tasks"), scope_note: str,
    definition: nullable(object({ text: str, language: enumeration("en", "zh-CN"), basis: enumeration(...Object.keys(ontologyModel.definition_bases)) })),
  }, ["scope_note"]),
  relations: object({
    id: str, kind: enumeration(...Object.keys(ontologyModel.relationship_kinds)),
    view: enumeration(...new Set(Object.values(ontologyModel.relationship_kinds).map((relation) => relation.view))),
    parent_id: str, child_id: str, order: { type: "integer", minimum: 0 },
  }),
  external_mappings: object({
    id: str, concept_id: str, source_id: str, external_type: enumeration(...Object.keys(ontologyModel.external_types)), external_id: str,
    relation: enumeration("source_projection", "related", "broader", "narrower", "exact"), method: enumeration("source_id", "ai_proposed", "reviewed"),
    status: enumeration("source_reference", "candidate", "reviewed"), explanation: str,
  }, ["explanation"]),
  sources: object({ id: str, version: str, url: uri, license: str, status: enumeration("reference", "editorial_draft"), note: str }, ["note"]),
  reference_occupation_groups: object({ id: str, source_code: str, label_en: str, source_version: str }),
  reference_occupations: object({ id: str, source_code: str, family_id: str, label_en: str, description_en: str, source_version: str, source_url: uri }),
  reference_tasks: object({ id: str, source_task_id: str, occupation_id: str, statement_en: str, task_type: nullable(str), source_version: str }),
  reference_activities: object({ id: str, source_id: str, kind: enumeration(...Object.keys(ontologyModel.reference_hierarchies.reference_activities)), label_en: str, parent_id: nullable(str) }),
  reference_task_activity_links: object({ task_id: str, activity_id: str, source_updated_month: str, domain_source: str }),
  reference_taxonomy_codes: object({ id: str, source_code: str, kind: enumeration(...Object.keys(ontologyModel.reference_hierarchies.reference_taxonomy_codes)), parent_id: nullable(str) }),
  coverage: object({ isic_section: str, domain_ids: { ...array(str), minItems: 1, uniqueItems: true }, coverage_note: str }),
};

export const ontologyCollections = Object.freeze(Object.keys(rowSchemas));
export const ontologySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://openaiwill.com/schemas/ontology/1.0.0/data.json",
  title: "openaiwill ontology 1.0.0",
  ...object(Object.fromEntries(Object.entries(rowSchemas).map(([name, schema]) => [name, array(schema)]))),
};
