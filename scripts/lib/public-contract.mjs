// The public data contract: JSON Schema for every entity an agent can read and an
// OpenAPI description of the HTTP interface, both projected from the ontology schema.
//
// Types, cardinalities and enumerated values come from datasets/ontology/schema/schema.json
// and nowhere else. What this file adds is the *publication view* of the ontology, which is
// not a type definition: which classes and properties are public, how much a reader may trust
// each field (its grade), which snapshot file carries an entity, and the denormalised fields a
// snapshot adds on top (joins such as an organisation's name). Every property named here must
// exist in the ontology; the generator throws otherwise.
//
// Wire rule: every declared field is always present. A value that is not known is `null`; a
// key is never dropped to mean "unknown", and 0 / "" / [] are real values (rule:three-states-are-not-zero).
import { schema, termIds, validateSchema } from "./ontology-schema.mjs";

/** The contract's own version. Moves independently of the ontology, the method and the data. */
export const CONTRACT_VERSION = "1.9.0";
export const CONTRACT_PATH = "contract/v1";

/**
 * How far a field's value can be trusted, and by what it was produced.
 *   quote    – words copied verbatim from the original source; checked against it
 *   excerpt  – shortened or reformatted from a source (metadata, counts, names as the source gives them)
 *   machine  – written or proposed by our pipeline; unreviewed unless `review_state` says otherwise
 *   human    – confirmed by a named person on record
 *   record   – our own bookkeeping: ids, timestamps, versions, controlled-vocabulary state
 */
export const GRADES = {
  quote: { en: "Original words copied from the source and checked against it.", "zh-CN": "从来源原样摘抄并与来源核对过的原文。" },
  excerpt: { en: "Shortened or reformatted from a source: names, counts and metadata as the source gives them.", "zh-CN": "从来源截取或整理的内容：来源给出的名称、数量和元数据。" },
  machine: { en: "Written or proposed by our pipeline. Not reviewed unless the record's review state says so.", "zh-CN": "由我们的流水线写出或提出。除非记录的复核状态另有说明，否则未经复核。" },
  human: { en: "Confirmed by a person on record.", "zh-CN": "经记录在案的人确认。" },
  record: { en: "Our own bookkeeping: identifiers, timestamps, versions and vocabulary states.", "zh-CN": "我们自己的记录：编号、时间、版本和词表状态。" },
};

/** The four versions every response and manifest keeps apart. */
export const VERSION_KINDS = {
  contract: "This contract: field names, types and grades.",
  ontology: "The ontology schema the records conform to.",
  method: "How progress and readings were computed.",
  data: "The published data release the answer was read from.",
};

const S = (type, extra = {}) => ({ type, ...extra });
const NULLABLE = (type) => [type, "null"];

/** Denormalised snapshot fields (joins and rollups). Typed loosely on purpose: see `x-shape`. */
const view = (type, grade, en, zh, { nullable = false, ...more } = {}) => ({ type, nullable, grade, definition: { en, "zh-CN": zh }, ...more });

/**
 * Entities in the contract. `class` is an ontology class. `fields` maps an ontology property to
 * its grade; `omit` names ontology properties that this collection does not carry on the wire;
 * `view` adds snapshot-only fields. `collection` is the snapshot file whose rows are this entity.
 */
export const ENTITIES = [
  {
    name: "Concept", class: "Concept", id: "id", title: { en: "Catalog concept (market, work, occupation)", "zh-CN": "目录条目（赛道、工作、职业）" },
    fields: {
      id: "record", kind: "record", label_en: "excerpt", label_zh_cn: "machine", origin: "record", translation_status: "record",
      scope_status: "record", scope_note: "machine", definition: "excerpt",
    },
  },
  {
    // A kind of work in a market: what an update lands on. 1.1.0, replacing the graded rows of `chain.activities`.
    name: "Work", class: "Concept", id: "id", collection: "work", title: { en: "Kind of work in a market", "zh-CN": "赛道里的工作" },
    fields: { id: "record", kind: "record", label_en: "excerpt", label_zh_cn: "machine" },
    omit: ["origin", "translation_status", "scope_status", "scope_note", "definition"],
    view: {
      market_id: view("string", "record", "The market the work belongs to.", "这项工作所属的赛道。"),
      market_en: view("string", "excerpt", "English name of that market.", "该赛道的英文名。"),
      market_zh_cn: view("string", "machine", "Chinese name of that market.", "该赛道的中文名。", { nullable: true }),
      tasks: view("integer", "machine", "Occupation tasks the work is proposed to cover (machine-proposed edges).", "这项工作被提议覆盖的职业任务数（机器提出的边）。"),
      updates: view("integer", "machine", "Published updates a judge linked to this work. 0 means none, not unknown.", "被判定与这项工作相关的已发布更新数。0 表示没有。"),
    },
  },
  {
    // 1.1.0, replacing the graded `progress.occupations`: tasks reached, nothing graded.
    name: "Occupation", class: "Concept", id: "id", collection: "occupations", title: { en: "Occupation", "zh-CN": "职业" },
    fields: { id: "record", kind: "record", label_en: "excerpt", label_zh_cn: "machine" },
    omit: ["origin", "translation_status", "scope_status", "scope_note", "definition"],
    view: {
      group_id: view("string", "record", "The occupation group.", "所属职业大类。", { nullable: true }),
      group_en: view("string", "excerpt", "English name of the group.", "大类的英文名。", { nullable: true }),
      group_zh_cn: view("string", "machine", "Chinese name of the group.", "大类的中文名。", { nullable: true }),
      tasks: view("integer", "excerpt", "Tasks of the occupation in the catalog (O*NET).", "目录（O*NET）中该职业的任务数。"),
      touched_tasks: view("integer", "machine", "Tasks covered by at least one kind of work that a published update was linked to. Says what was collected, not what AI can do.", "至少被一项有已发布更新关联的工作覆盖的任务数。说的是采集到了什么，不是 AI 能做什么。"),
      markets: view("array", "machine", "Markets the occupation serves: market id, confidence and status of the machine-proposed edge.", "该职业服务的赛道：赛道编号及机器提出的边的置信度与状态。"),
      // 1.6.0 (Issue #30): Occupation.alt_label, sealed in the ontology from 2.6.0.
      alt_labels_en: view("array", "excerpt", "Other English names to find the occupation by: job titles its workers reported to O*NET, as written there. A title can be narrower than the occupation. Null when the release carries none.", "可用来找到该职业的其他英文名：从业者向 O*NET 报告的职称，原样保留。职称可能比职业窄。发布未带别名时为 null。", { nullable: true, itemType: "string", ontology: "Occupation.alt_label" }),
      alt_labels_zh_cn: view("array", "machine", "Other Chinese names to find the occupation by: AI translations of the reported titles and up to three model-proposed common names. One name can belong to several occupations; they find an occupation, they do not define it. Null when the release carries none.", "可用来找到该职业的其他中文名：报告职称的 AI 翻译，及模型提出的至多三个常用叫法。同一个名字可能属于几个职业；只用于查找，不定义职业。发布未带别名时为 null。", { nullable: true, itemType: "string", ontology: "Occupation.alt_label" }),
    },
  },
  {
    name: "Organization", class: "Organization", id: "org_id", title: { en: "Organization", "zh-CN": "组织" },
    fields: { org_id: "record", canonical_name_en: "excerpt", canonical_name_zh_cn: "machine", aliases: "excerpt" },
  },
  {
    name: "Person", class: "Person", id: "person_id", title: { en: "Person", "zh-CN": "人物" },
    fields: { person_id: "record", name: "excerpt", aliases: "excerpt", identity_url: "excerpt" },
  },
  {
    name: "SourceAccount", class: "SourceAccount", id: "account_key", collection: "sources", title: { en: "Source account", "zh-CN": "来源账号" },
    fields: {
      account_key: "record", platform: "record", handle: "excerpt", owner_kind: "machine", panel_role: "machine",
      identity_grade: "machine", identity_url: "excerpt", avatar_url: "excerpt", language: "machine", focus: "machine",
    },
    omit: ["platform_account_id", "panel_state", "excluded", "added_from", "state_changed_at"],
    // The ontology types identity_url as a uri, but 31 of 374 rows hold the evidence note that
    // found it ("https://… (links @handle)"). The contract tells the truth about the wire until
    // the data or the ontology is corrected; see the follow-up issue linked from the PR.
    wireRange: { identity_url: "text" },
    view: {
      person_id: view("string", "record", "The person behind the account, when it is a person on record.", "账号背后的人物（在名单里时）。", { nullable: true }),
      org_id: view("string", "record", "The organization behind the account, when it is one on record.", "账号背后的组织（在名单里时）。", { nullable: true }),
      name: view("string", "excerpt", "Display name.", "显示名称。"),
      name_zh_cn: view("string", "machine", "Chinese display name.", "中文显示名称。", { nullable: true }),
      followers: view("integer", "excerpt", "Follower count at `followers_at`.", "`followers_at` 时的关注者数。", { nullable: true }),
      followers_at: view("string", "record", "When the follower count was read.", "读取关注者数的时间。", { nullable: true, format: "date-time" }),
      affiliations: view("array", "excerpt", "Affiliations with organizations: relation, role title, start and end when known.", "与组织的任职或隶属关系。"),
      posts: view("integer", "record", "Posts collected from the account.", "已收集的帖子数。", { nullable: true }),
      latest_post_at: view("string", "record", "Publication time of the newest collected post.", "最新一条已收集帖子的发布时间。", { nullable: true, format: "date-time" }),
      latest: view("array", "excerpt", "Recent posts: id, url, publication time, an excerpt of the text and engagement counts.", "最近的帖子：编号、地址、发布时间、正文摘录和互动数。"),
    },
  },
  {
    name: "Event", class: "Event", id: "event_id", collection: "events", title: { en: "Event", "zh-CN": "事件" },
    fields: {
      event_id: "record", kind: "machine", kind_vocabulary: "record", subject_key: "machine", title: "machine", summary: "machine",
      announced_at: "excerpt", occurred_at: "excerpt", confidence: "machine", identity_confidence: "machine",
      subject: "machine", basis: "machine", task: "machine", result: "machine", quote: "quote", schema_version: "record",
      // 1.9.0: null when the event has a kind, in releases before it, and until a pass has read the event.
      unresolved_class: "machine",
    },
    omit: ["actor_account_key", "occurrence_status", "scheduled_for"],
    // Written only for updates with no `occurred_at` (their first source post's time), so dated updates stay byte-identical.
    optionalKeys: ["announced_at"],
    view: {
      unresolved_reason: view("string", "machine", "Why the event has no kind yet, when `kind` is null.", "`kind` 为空时，事件为什么还没有类型。", { nullable: true }),
      primary_org_id: view("string", "record", "The organization the event is about.", "事件所属的组织。"),
      org_name: view("string", "excerpt", "English name of that organization.", "该组织的英文名。"),
      org_name_zh_cn: view("string", "machine", "Chinese name of that organization.", "该组织的中文名。"),
      facts: view("array", "quote", "Numbers the source states, each with the words that state it.", "来源给出的数字，各带出处原话。", { nullable: true }),
      source_count: view("integer", "record", "Source posts behind the event.", "支持该事件的来源帖子数。"),
      source_urls: view("array", "record", "Addresses of the source posts.", "来源帖子的地址。", { itemType: "string" }),
      attention: view("object", "excerpt", "Engagement counts of the leading source post when read.", "主来源帖子被读取时的互动数。"),
      series_size: view("integer", "record", "Posts in the thread when the source is a numbered thread.", "来源为串文时，串内帖子数。", { nullable: true }),
      models: view("array", "machine", "Models the event names, with their role.", "事件涉及的模型及其角色。"),
      work: view("array", "machine", "Kinds of work a judge linked the event to (`activity_id`), each with posts by others that said the same (`confirmations`; recorded, not verified). 1.1.0.", "判定与该事件相关的工作（`activity_id`），各带别人也这么说的帖子（`confirmations`；只记录不核实）。1.1.0 新增。"),
    },
  },
  {
    name: "Model", class: "Model", id: "model_id", collection: "models", title: { en: "Model", "zh-CN": "模型" },
    fields: {
      model_id: "record", org_id: "record", level: "machine", parent_model_id: "record", name: "excerpt", version: "excerpt",
      variant: "excerpt", status: "machine", released_at: "excerpt",
    },
    omit: ["owner_name", "first_seen_event_id", "catalog_id", "catalog_released_on", "open_weights", "output_modalities"],
    view: {
      owner: view("string", "excerpt", "Name of the owning organization.", "所属组织的名称。", { nullable: true }),
      owner_zh_cn: view("string", "machine", "Chinese name of the owning organization.", "所属组织的中文名。", { nullable: true }),
      events: view("integer", "record", "Events that name the model.", "提到该模型的事件数。"),
    },
  },
  {
    name: "Provider", class: "Provider", id: "provider_id", title: { en: "Model provider", "zh-CN": "模型提供方" },
    fields: { provider_id: "record", name: "excerpt", kind: "machine" },
  },
  {
    name: "Product", class: "Product", id: "product_id", title: { en: "Product", "zh-CN": "产品" },
    fields: { product_id: "record", org_id: "record", owner_name: "excerpt", name: "excerpt", category: "machine", created_at: "record" },
  },
  {
    name: "ProductAvailability", class: "ProductAvailability", id: "availability_id", title: { en: "Product availability", "zh-CN": "产品可用性" },
    fields: {
      availability_id: "record", product_id: "record", as_of: "record", stage: "machine", channel: "excerpt",
      region: "excerpt", audience: "excerpt", price: "excerpt", source_url: "record",
    },
  },
  {
    // 1.2.0: the snapshot's `observations.json`. Heads of merges only; a merged id is listed under `merged_from`.
    name: "Observation", class: "Observation", id: "observation_id", collection: "observations", title: { en: "Observation", "zh-CN": "观察" },
    fields: {
      observation_id: "record", actor_key: "machine", actor_org_id: "record", actor_person_id: "record", actor_name: "excerpt",
      actor_role: "machine", subject_key: "machine", subject_product_id: "record", subject_model_id: "record", work_key: "machine",
      event_id: "record", task: "machine", evidence_type: "machine", outcome: "machine", direction: "machine", scale: "machine",
      conditions: "machine", occurred_on: "excerpt", announced_at: "excerpt", observed_at: "record", review_state: "record",
      reviewed_at: "record", extractor: "record", prompt_sha256: "record", model: "record", schema_version: "record", created_at: "record",
    },
    view: {
      sources: view("array", "quote", "Where it was said: source_ref, source_type, url, source_id (the collected post, for X), the quote checked against the source, and its publication time. Includes the sources of observations merged into this one.", "出处：source_ref、来源类型、地址、source_id（X 帖子的采集编号）、与来源核对过的原话及发布时间。含并入本条的观察的出处。"),
      facts: view("array", "excerpt", "Numbers the source states: fact_id, value, unit, what it counts, baseline, method note, and the quote that states it.", "来源给出的数值：fact_id、值、单位、指什么、比较基线、口径说明及出处原话。"),
      concerns: view("array", "machine", "Catalog entries the work was put on: concept_id, kind (`work` market work item, `occupation`, `task` O*NET task), English and Chinese labels, `occupation_id` (1.7.0: the occupation a task belongs to; null for other kinds, absent in older releases), method and status. Machine-proposed candidates unless status says `reviewed`. Empty when nothing fit (`work_key` is then `unmapped`).", "这项工作被归到的目录条目：concept_id、类别（`work` 赛道工作项、`occupation` 职业、`task` O*NET 任务）、中英名称、`occupation_id`（1.7.0：任务所属的职业；其他类别为 null，旧版本没有此字段）、方法与状态。除非状态为 `reviewed`，均为机器提出的候选。都对不上时为空（此时 `work_key` 为 `unmapped`）。"),
      merged_from: view("array", "record", "Ids of observations found to be this same one. They are not published as rows of their own; an id here redirects to this row.", "被判定与本条是同一件事的观察编号。它们不再单独发布；这里的编号都重定向到本条。", { itemType: "string" }),
    },
  },
  {
    name: "ObservationSource", class: "ObservationSource", id: "source_ref", title: { en: "Observation source", "zh-CN": "观察出处" },
    fields: { source_ref: "record", observation_id: "record", source_type: "record", url: "record", source_id: "record", quote: "quote", published_at: "excerpt" },
  },
  {
    name: "ObservationFact", class: "ObservationFact", id: "fact_id", title: { en: "Observation fact", "zh-CN": "观察事实" },
    fields: { fact_id: "record", observation_id: "record", value: "excerpt", unit: "excerpt", what: "excerpt", baseline: "excerpt", method_note: "machine", quote: "quote" },
  },
  {
    name: "Topic", class: "Topic", id: "topic_id", collection: "topics", title: { en: "Topic", "zh-CN": "话题" },
    fields: { topic_id: "record", question_type: "machine", state: "record", origin: "record", opened_at: "record" },
    omit: ["object_key", "question_en", "question_zh_cn", "state_changed_at", "schema_version"],
    // Releases made before 1.8.0 have no observation_evidence.
    optionalKeys: ["observation_evidence"],
    view: {
      slug: view("string", "record", "URL-safe form of the id.", "编号的网址形式。"),
      object: view("string", "machine", "What the question is about, in words.", "问题所涉对象的文字。"),
      question: view("object", "machine", "The closed question in `en` and `zh-CN`.", "封闭问题，含 `en` 与 `zh-CN`。"),
      sides: view("string", "machine", "Whether the answers split the evidence (`open` while undecided).", "各答案是否分化。"),
      about: view("object", "machine", "The occupation or market the question concerns: id, kind, English and Chinese labels. A candidate.", "问题所涉的职业或赛道（候选）。", { nullable: true }),
      group: view("object", "machine", "Its group: id, English and Chinese labels. A candidate.", "所属大类（候选）。", { nullable: true }),
      latest_claim_at: view("string", "record", "Publication time of the newest claim.", "最新一条主张的发布时间。", { format: "date-time" }),
      accounts: view("integer", "record", "Accounts that made claims.", "发表主张的账号数。"),
      posts: view("integer", "record", "Posts that made claims.", "发表主张的帖子数。"),
      options: view("array", "machine", "Answers: option id, key, position, text in both languages and tallies.", "各答案：编号、键、顺序、双语文本和计数。"),
      claims: view("array", "quote", "Posts arguing for an answer, each with the original quote.", "支持某个答案的帖子，各带原文引用。"),
      evidence: view("array", "machine", "Deprecated since 1.8.0, empty in releases made from then on: updates a judge weighed against an answer. Observations replace them in `observation_evidence`.", "1.8.0 起弃用，此后发布的版本为空：判官曾拿来对照某个答案的更新。由 `observation_evidence` 里的观察取代。"),
      observation_evidence: view("array", "machine", "Observations weighing on an answer (1.8.0): `observation_id` (a row of `observations.json`; a merged observation counts as the one it was merged into), `option` (the answer's key), `sign` (`supports` or `contradicts`) and the judge's `confidence`. A model's proposal, not a conclusion; it says which way an observation weighs, never which answer is right. Absent in older releases.", "对某个答案有分量的观察（1.8.0）：`observation_id`（`observations.json` 中的一行；已合并的观察算作并入的那一条）、`option`（答案的键）、`sign`（`supports` 或 `contradicts`）及判官的 `confidence`。是模型的提议，不是结论；它说明观察偏向哪一边，不说明哪个答案是对的。旧版本没有此字段。"),
      by_quarter: view("object", "record", "Claims per answer per calendar quarter.", "按自然季度统计的各答案主张数。"),
    },
  },
  {
    name: "TopicOption", class: "TopicOption", id: "option_id", title: { en: "Topic option", "zh-CN": "话题答案" },
    fields: { option_id: "record", topic_id: "record", position: "record", text_en: "machine", text_zh_cn: "machine", retired: "record" },
  },
];

/** Snapshot files that stay out of the contract: level readings, retired by Issue #35. */
export const RETIRED_COLLECTIONS = [
  { file: "chain", reason: "Activity and level readings; retired with the L0–L5 scale (Issue #35). Ungraded links are `Event.work`, the work itself `work.json`." },
  { file: "markets", reason: "Market-to-occupation edges; carried on `occupations.json` rows since 1.1.0 (Issue #35)." },
  { file: "tasks", reason: "Work-to-task edges; folded into counts on `work.json` and `occupations.json` since 1.1.0 (Issue #35)." },
  { file: "progress", reason: "A takeover-progress figure; retired with the level scale (Issue #35). Ungraded task counts are on `occupations.json`." },
  { file: "coverage", reason: "Collection-window description; moves into the manifest with observations (Issue #25)." },
];

const props = schema.properties;

function propertyOf(cls, name) {
  const def = props[`${cls}.${name}`];
  if (!def) throw new Error(`public contract names ${cls}.${name}, which is not in the ontology schema`);
  return def;
}

const RANGES = {
  string: () => S("string"),
  text: () => S("string"),
  uri: () => S("string", { format: "uri" }),
  datetime: () => S("string", { format: "date-time" }),
  date: () => S("string", { format: "date" }),
  boolean: () => S("boolean"),
  integer: () => S("integer"),
  number: () => S("number"),
  object: () => S("object"),
};

function baseSchema(range) {
  if (range.startsWith("vocabulary:")) return S("string", { enum: termIds(range.slice("vocabulary:".length)) });
  if (range.startsWith("class:")) return S("string", { description: `Identifier of a ${range.slice("class:".length)}.` });
  const make = RANGES[range];
  if (!make) throw new Error(`no JSON Schema form for ontology range ${range}`);
  return make();
}

/** Nullable form of a schema whose `type` is a single token: `type: [T, "null"]`, and `null` in `enum`. */
function nullable(s) {
  const out = { ...s, type: NULLABLE(s.type) };
  if (s.enum) out.enum = [...s.enum, null];
  return out;
}

const textOf = (definition) => definition?.en ?? "";

function fieldSchema(entity, name, grade) {
  const def = propertyOf(entity.class, name);
  let s = baseSchema(entity.wireRange?.[name] ?? def.range);
  const many = def.max === "*" || def.max === "n" || (typeof def.max === "string" && def.max !== "1");
  if (many) s = S("array", { items: s });
  else if (def.min === 0) s = nullable(s);
  return {
    ...s,
    description: textOf(def.definition),
    "x-description-zh-CN": def.definition?.["zh-CN"] ?? "",
    "x-grade": grade,
    "x-ontology-property": `${entity.class}.${name}`,
    ...(def.since ? { "x-since": def.since } : {}),
    ...(entity.wireRange?.[name] && entity.wireRange[name] !== def.range ? { "x-wire-range": entity.wireRange[name], "x-ontology-range": def.range } : {}),
  };
}

function viewSchema(name, v) {
  let s = S(v.type, v.format ? { format: v.format } : {});
  if (v.type === "array") s.items = v.itemType ? S(v.itemType) : { type: "object" };
  if (v.nullable) s = nullable(s);
  return {
    ...s,
    description: v.definition.en,
    "x-description-zh-CN": v.definition["zh-CN"],
    "x-grade": v.grade,
    "x-shape": "view",
    ...(v.ontology ? { "x-ontology-property": v.ontology } : {}),
  };
}

/** One entity's JSON Schema (draft 2020-12). */
export function entitySchema(entity) {
  const cls = schema.classes[entity.class];
  if (!cls) throw new Error(`public contract names class ${entity.class}, which is not in the ontology schema`);
  for (const name of entity.omit ?? []) propertyOf(entity.class, name);
  const covered = new Set([...Object.keys(entity.fields), ...(entity.omit ?? [])]);
  const missing = Object.keys(props)
    .filter((key) => key.startsWith(`${entity.class}.`))
    .map((key) => key.split(".")[1])
    .filter((name) => !covered.has(name));
  if (missing.length) throw new Error(`${entity.class}: ontology properties neither public nor omitted: ${missing.join(", ")}`);
  const properties = {};
  for (const [name, grade] of Object.entries(entity.fields)) {
    if (!(grade in GRADES)) throw new Error(`${entity.class}.${name}: unknown grade ${grade}`);
    properties[name] = fieldSchema(entity, name, grade);
    if (entity.optionalKeys?.includes(name)) properties[name]["x-key-optional"] = true;
  }
  for (const [name, v] of Object.entries(entity.view ?? {})) {
    if (name in properties) throw new Error(`${entity.class}.${name} is both an ontology field and a view field`);
    if (!(v.grade in GRADES)) throw new Error(`${entity.class}.${name}: unknown grade ${v.grade}`);
    properties[name] = viewSchema(name, v);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://surviagi.com/${CONTRACT_PATH}/schemas/${entity.name}.schema.json`,
    title: entity.title.en,
    "x-title-zh-CN": entity.title["zh-CN"],
    description: textOf(cls.definition),
    "x-description-zh-CN": cls.definition?.["zh-CN"] ?? "",
    type: "object",
    properties,
    required: Object.keys(properties).filter((name) => !entity.optionalKeys?.includes(name)),
    additionalProperties: false,
    "x-identifier": entity.id,
    ...(entity.collection ? { "x-snapshot-file": `${entity.collection}.json` } : {}),
    ...(cls.since ? { "x-since": cls.since } : {}),
  };
}

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

/** The vocabularies observations are filtered by, as the agent API accepts them. */
const OBSERVATION_ENUMS = {
  evidence_type: termIds("event_basis"),
  direction: termIds("observation_direction"),
  outcome: termIds("event_result"),
  review_state: termIds("observation_review"),
};
const jsonBody = (schemaRef, description) => ({ description, content: { "application/json": { schema: schemaRef } } });

const LANGUAGE = { name: "language", in: "query", required: false, schema: { type: "string", enum: ["en", "zh-CN"], default: "en" }, description: "Language of page links and labels." };
const ERRORS = {
  "400": jsonBody(ref("Error"), "A parameter is missing or malformed."),
  "429": jsonBody(ref("Error"), "At most 60 reads a minute from one address."),
};

function versionsSchema() {
  return {
    type: "object",
    description: "The four versions kept apart. A client that pins one of them can detect a change in any of them.",
    properties: {
      contract: S("string", { description: VERSION_KINDS.contract }),
      ontology: S("string", { description: VERSION_KINDS.ontology }),
      method: NULLABLE_DESC("string", VERSION_KINDS.method),
      data: NULLABLE_DESC("string", VERSION_KINDS.data),
    },
    required: ["contract", "ontology", "method", "data"],
    additionalProperties: false,
  };
}
function NULLABLE_DESC(type, description) {
  return { type: NULLABLE(type), description };
}

/** The OpenAPI 3.1 description of the agent HTTP interface. */
export function openApi(entityNames) {
  return {
    openapi: "3.1.0",
    info: {
      title: "SurviAGI agent API",
      version: CONTRACT_VERSION,
      description:
        "Read-only access to published SurviAGI records and key-gated submissions. Every record is machine-proposed unless its review state says otherwise; cite the source URLs, not our summaries. " +
        "Entity field names, types and grades are in the JSON Schemas listed under `x-entities`.",
      "x-ontology-version": schema.version,
    },
    servers: [{ url: "https://surviagi.com" }],
    "x-entities": entityNames.map((name) => ({ name, schema: `/${CONTRACT_PATH}/schemas/${name}.schema.json` })),
    paths: {
      "/api/agent/search": {
        get: {
          operationId: "search",
          summary: "Search published records.",
          description: "Ranks updates, topics, observations, evidence readings and public articles against the query. A search that finds nothing starts no research.",
          parameters: [
            { name: "query", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 200 }, description: "What to look for, in English or Chinese. `q` is accepted as an alias." },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 8 } },
            { name: "types", in: "query", schema: { type: "array", items: { type: "string", enum: ["update", "question", "observation", "evidence", "article"] } }, style: "form", explode: false, description: "Comma-separated record types. Default: update, question, observation and article; evidence (deprecated) only when named." },
            { name: "status", in: "query", schema: { type: "string", enum: ["approved", "preview"] }, description: "For articles only." },
            { name: "from", in: "query", schema: { type: "string", format: "date" } },
            { name: "to", in: "query", schema: { type: "string", format: "date" } },
            LANGUAGE,
          ],
          responses: { "200": jsonBody(ref("SearchResponse"), "Matching records."), ...ERRORS, "503": jsonBody(ref("Error"), "Article search is unavailable.") },
        },
      },
      "/api/agent/record": {
        get: {
          operationId: "getRecord",
          summary: "Read one record in full.",
          parameters: [
            { name: "id", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 260 }, description: "An id returned by search." },
            LANGUAGE,
          ],
          responses: { "200": jsonBody(ref("RecordResponse"), "The record."), ...ERRORS, "404": jsonBody(ref("Error"), "No record with this id in the loaded release.") },
        },
      },
      "/api/agent/observations": {
        get: {
          operationId: "queryObservations",
          summary: "List observations, filtered, with counts over everything that matches.",
          description: "Occupation and market select exactly the observations their pages list, so the counts equal the page's. Pages through the rows with `cursor`; a cursor of an earlier data release is refused.",
          parameters: [
            { name: "occupation", in: "query", schema: { type: "string", maxLength: 200 }, description: "Occupation id, O*NET code, name (English or Chinese), or another name it is known by (1.6.0: \"software engineer\", \"程序员\"); a name of several occupations answers 404 with candidates." },
            { name: "market", in: "query", schema: { type: "string", maxLength: 200 }, description: "Market id, slug or name." },
            { name: "task", in: "query", schema: { type: "string", maxLength: 120 }, description: "Task id, e.g. oaw:task:21593." },
            { name: "organization", in: "query", schema: { type: "string", maxLength: 200 }, description: "Organization id, actor key or exact actor name." },
            { name: "subject", in: "query", schema: { type: "string", maxLength: 200 }, description: "Product or model key or id." },
            ...[["evidence_types", OBSERVATION_ENUMS.evidence_type], ["directions", OBSERVATION_ENUMS.direction], ["outcomes", OBSERVATION_ENUMS.outcome], ["review_states", OBSERVATION_ENUMS.review_state]].map(([name, values]) => (
              { name, in: "query", schema: { type: "array", items: { type: "string", enum: values } }, style: "form", explode: false, description: "Comma-separated; any of them." })),
            { name: "from", in: "query", schema: { type: "string", format: "date" } },
            { name: "to", in: "query", schema: { type: "string", format: "date" } },
            { name: "recorded_since", in: "query", schema: { type: "string", maxLength: 64 }, description: "Only observations first recorded after this: a data release id, a date (from its start, UTC) or a time with offset." },
            { name: "order", in: "query", schema: { type: "string", enum: ["strength", "newest", "recorded"], default: "strength" }, description: "recorded: last recorded first." },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
            { name: "cursor", in: "query", schema: { type: "string" }, description: "`next_cursor` of the previous page." },
            LANGUAGE,
          ],
          responses: { "200": jsonBody(ref("ObservationsResponse"), "One page of matching observations."), ...ERRORS, "404": jsonBody(ref("Error"), "No occupation or market matches; `candidates` lists near matches.") },
        },
      },
      "/api/agent/changes": {
        get: {
          operationId: "changesSince",
          summary: "What is new since an earlier data release or a moment.",
          description: "Everything listed was recorded or published after `since`, so none of it can be in an earlier release. Updates carry no recorded time: those listed happened after it, a lower bound. With occupation or market, updates and articles are null.",
          parameters: [
            { name: "since", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 64 }, description: "A data release id (`versions.data` of an earlier answer), a date YYYY-MM-DD (from its start, UTC) or a time with offset." },
            { name: "occupation", in: "query", schema: { type: "string", maxLength: 200 }, description: "Only what is new for this occupation: id, O*NET code, name, or another name it is known by." },
            { name: "market", in: "query", schema: { type: "string", maxLength: 200 }, description: "Only what is new for this market: id, slug or name." },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 }, description: "Items per list; totals count all." },
            LANGUAGE,
          ],
          responses: { "200": jsonBody(ref("ChangesResponse"), "What changed."), ...ERRORS, "404": jsonBody(ref("Error"), "No occupation or market matches; `candidates` lists near matches."), "503": jsonBody(ref("Error"), "Article reading is unavailable.") },
        },
      },
      "/api/agent/summary": {
        get: {
          operationId: "occupationSummary",
          summary: "Evidence statistics of one occupation or market, as its page states them.",
          parameters: [
            { name: "occupation", in: "query", schema: { type: "string", maxLength: 200 }, description: "Occupation id, O*NET code, name, or another name it is known by. Give this or market." },
            { name: "market", in: "query", schema: { type: "string", maxLength: 200 }, description: "Market id, slug or name." },
            LANGUAGE,
          ],
          responses: { "200": jsonBody(ref("SummaryResponse"), "The statistics."), ...ERRORS, "404": jsonBody(ref("Error"), "No occupation or market matches; `candidates` lists near matches.") },
        },
      },
    },
    components: {
      schemas: {
        Versions: versionsSchema(),
        Error: {
          type: "object",
          properties: { error: S("string", { enum: ["invalid", "rate", "not_found", "unavailable", "unauthorized", "forbidden", "quota"] }), message: S("string") },
          required: ["error", "message"],
        },
        SearchResult: {
          type: "object",
          description: "One hit. Article hits carry extra revision fields (status, version, evidence cutoff).",
          properties: {
            id: S("string"),
            type: S("string", { enum: ["update", "question", "observation", "evidence", "article"] }),
            title: S("string"),
            snippet: S("string"),
            title_language: S("string", { enum: ["en", "zh-CN"], description: "The language the title and snippet are written in. Chinese only where the record has its own Chinese text; nothing is machine-translated for the answer." }),
            matched: {
              type: "array",
              description: "Why the record matched: each field that held query terms, with those terms. A Chinese query can match an English record through the names in both languages it carries (`work`, `concerns`, `about`).",
              items: { type: "object", properties: { field: S("string"), terms: { type: "array", items: S("string") } }, required: ["field", "terms"] },
            },
            content: S("string", { description: "What kind of text the snippet is; see `content_kinds`.", enum: ["machine_summary", "post_quote", "machine_reading", "editorial_article"] }),
            review: S("string", { description: "Review state of the record. `machine_proposed_unreviewed` until a person confirms." }),
            date: NULLABLE_DESC("string", "The record's own date."),
            organization: NULLABLE_DESC("string", "The organization the record is about."),
            url: S("string", { format: "uri" }),
            markdown_url: S("string", { format: "uri" }),
            sources: { type: "array", items: S("string", { format: "uri" }), description: "Addresses of the original sources." },
          },
          required: ["id", "type", "title", "snippet", "title_language", "matched", "content", "date", "organization", "url", "markdown_url", "sources"],
        },
        SearchResponse: {
          type: "object",
          properties: {
            query: S("string"),
            total: S("integer"),
            results: { type: "array", items: ref("SearchResult") },
            aliases: {
              type: "array",
              description: "Other names of occupations found in the query (1.6.0): each stands for the occupations listed, and a record naming any of them, in either language, matched it. The occupations are named by their own names; a name of more than three occupations stands for none.",
              items: { type: "object", properties: { term: S("string"), occupations: { type: "array", items: { type: "object", properties: { id: S("string"), label_en: S("string"), label_zh_cn: NULLABLE_DESC("string", "Chinese name.") }, required: ["id", "label_en", "label_zh_cn"] } } }, required: ["term", "occupations"] },
            },
            release: { type: "object", description: "The loaded data release.", properties: { id: S("string"), generated_at: NULLABLE_DESC("string", "When the snapshot was built."), method: NULLABLE_DESC("string", "Method version.") } },
            versions: ref("Versions"),
            content_kinds: { type: "object", additionalProperties: S("string") },
            editorial_articles: { type: ["object", "null"], description: "Article store availability and hit count; null when articles were not requested.", properties: { available: { type: ["boolean", "null"] }, count: S("integer") } },
            note: S("string"),
          },
          required: ["query", "total", "results", "aliases", "release", "versions", "content_kinds", "editorial_articles", "note"],
        },
        ObservationCounts: {
          type: ["object", "null"],
          description: "Counts as of the data release's date; null when the release carries no observations (unknown, not zero).",
          properties: {
            as_of: NULLABLE_DESC("string", "The release date the 30/90-day windows end on."),
            total: S("integer"),
            by_evidence_type: { type: "object", additionalProperties: S("integer") },
            by_direction: { type: "object", additionalProperties: S("integer") },
            by_outcome: { type: "object", additionalProperties: S("integer") },
            against: S("integer", { description: "Saying a person is still needed, or that the AI fell short." }),
            last_30_days: S("integer"),
            last_90_days: S("integer"),
            undated: S("integer"),
          },
          required: ["as_of", "total", "by_evidence_type", "by_direction", "by_outcome", "against", "last_30_days", "last_90_days", "undated"],
        },
        ObservationSummary: {
          type: "object",
          description: "One observation as a list shows it. Read it in full with /api/agent/record.",
          properties: {
            id: S("string"),
            type: S("string", { enum: ["observation"] }),
            date: NULLABLE_DESC("string", "When it was said in public."),
            evidence_type: S("string", { enum: OBSERVATION_ENUMS.evidence_type }),
            evidence_type_label: S("string"),
            direction: S("string", { enum: OBSERVATION_ENUMS.direction }),
            outcome: S("string", { enum: OBSERVATION_ENUMS.outcome }),
            task: S("string", { description: "Machine-written: what was done." }),
            actor: { type: "object" },
            subject: { type: ["string", "null"] },
            facts: { type: "array", items: { type: "object", properties: { value: S("string"), unit: { type: ["string", "null"] }, what: S("string"), quote: S("string") }, required: ["value", "unit", "what", "quote"] } },
            sources: { type: "array", items: { type: "object", properties: { url: S("string", { format: "uri" }), quote: S("string"), published_at: { type: ["string", "null"] } }, required: ["url", "quote", "published_at"] } },
            review_state: S("string", { enum: OBSERVATION_ENUMS.review_state }),
            recorded_at: S("string", { description: "When it was first recorded in the ledger." }),
            url: { type: ["string", "null"], format: "uri" },
            markdown_url: { type: ["string", "null"], format: "uri" },
          },
          required: ["id", "type", "date", "evidence_type", "direction", "outcome", "task", "actor", "subject", "facts", "sources", "review_state", "recorded_at", "url", "markdown_url"],
        },
        ChangesResponse: {
          type: "object",
          properties: {
            since: {
              type: "object",
              properties: { given: S("string"), basis: S("string", { enum: ["release", "date", "time"] }), at: S("string", { description: "The moment compared against, UTC." }) },
              required: ["given", "basis", "at"],
            },
            scope: { type: "object" },
            same_release: S("boolean", { description: "The release given is the one loaded: nothing in it is new." }),
            observations: {
              type: ["object", "null"],
              description: "Null when the loaded release carries no observations (unknown, not none).",
              properties: {
                recorded: {
                  type: "object",
                  properties: {
                    total: S("integer"),
                    counts: ref("ObservationCounts"),
                    pages: { type: ["array", "null"], description: "Occupation and market pages the new observations reach, most first; null when scoped." },
                    results: { type: "array", items: ref("ObservationSummary") },
                    more: { type: ["object", "null"], description: "query_observations arguments that page through all of them." },
                  },
                  required: ["total", "counts", "pages", "results", "more"],
                },
                new_sources: { type: "object", properties: { total: S("integer"), results: { type: "array" } }, required: ["total", "results"] },
                reviewed: { type: "object", properties: { total: S("integer"), results: { type: "array" } }, required: ["total", "results"] },
              },
              required: ["recorded", "new_sources", "reviewed"],
            },
            topics: { type: "object", properties: { opened: { type: "object" }, new_claims: { type: "object" } }, required: ["opened", "new_claims"] },
            updates: { type: ["object", "null"], description: "Updates that happened after `since`; null when scoped." },
            articles: { type: ["object", "null"], description: "Public article revisions written or approved after `since`; null when scoped." },
            release: { type: "object" },
            versions: ref("Versions"),
            note: S("string"),
          },
          required: ["since", "scope", "same_release", "observations", "topics", "updates", "articles", "release", "versions", "note"],
        },
        ObservationsResponse: {
          type: "object",
          properties: {
            published: S("boolean", { description: "Whether the loaded release carries observations at all." }),
            filters: { type: "object" },
            total: { type: ["integer", "null"] },
            counts: ref("ObservationCounts"),
            results: { type: "array", items: ref("ObservationSummary") },
            next_cursor: { type: ["string", "null"] },
            release: { type: "object" },
            versions: ref("Versions"),
            note: S("string"),
          },
          required: ["published", "filters", "total", "counts", "results", "next_cursor", "release", "versions", "note"],
        },
        SummaryResponse: {
          type: "object",
          properties: {
            kind: S("string", { enum: ["occupation", "market"] }),
            id: S("string"),
            label: S("string"),
            label_zh_cn: { type: ["string", "null"] },
            url: S("string", { format: "uri" }),
            markdown_url: S("string", { format: "uri" }),
            state: S("string", { enum: ["unpublished", "none", "some"] }),
            counts: ref("ObservationCounts"),
            strongest: { type: "array", items: ref("ObservationSummary") },
            other_way: { type: "array", items: ref("ObservationSummary") },
            versions: ref("Versions"),
            note: S("string"),
          },
          required: ["kind", "id", "label", "url", "markdown_url", "state", "counts", "versions", "note"],
        },
        RecordResponse: {
          type: "object",
          description: "A full record: its text, sources and the release it came from. Shape depends on the record type.",
          properties: { id: S("string"), type: S("string"), versions: ref("Versions") },
          required: ["id", "type", "versions"],
        },
      },
    },
  };
}

/** The index: versions, entity list and where each schema lives. */
export function contractIndex(entities = ENTITIES) {
  return {
    contract_version: CONTRACT_VERSION,
    ontology_version: schema.version,
    name: "SurviAGI public data contract",
    "x-name-zh-CN": "SurviAGI 公开数据契约",
    versions: VERSION_KINDS,
    wire_rules: {
      en: [
        "Every field a schema declares is always present. Unknown is `null`; a key is never omitted to mean unknown.",
        "0, the empty string and the empty list are real values, never stand-ins for unknown.",
        "Dates are ISO 8601; `date-time` values carry an offset.",
        "A field added in a minor version is optional to read; a field is deprecated for at least one minor version before it is removed.",
      ],
      "zh-CN": [
        "schema 声明的每个字段都一定出现。未知是 `null`，不会用缺键表示未知。",
        "0、空字符串、空列表都是真值，不代表未知。",
        "日期用 ISO 8601；`date-time` 带时区偏移。",
        "小版本新增的字段读取方可忽略；字段至少经过一个小版本的弃用期才会移除。",
      ],
    },
    grades: GRADES,
    entities: entities.map((e) => ({
      name: e.name,
      title: e.title,
      identifier: e.id,
      schema: `/${CONTRACT_PATH}/schemas/${e.name}.schema.json`,
      snapshot_file: e.collection ? `${e.collection}.json` : null,
    })),
    retired_collections: RETIRED_COLLECTIONS,
    openapi: `/${CONTRACT_PATH}/openapi.json`,
  };
}

/** Every file of the contract as { relative path: JSON text }. Deterministic. */
export function buildContract() {
  const problems = validateSchema();
  if (problems.length) throw new Error(`ontology schema is invalid, refusing to project a contract:\n${problems.join("\n")}`);
  const files = {};
  for (const entity of ENTITIES) files[`schemas/${entity.name}.schema.json`] = entitySchema(entity);
  files["openapi.json"] = openApi(ENTITIES.map((e) => e.name));
  files["index.json"] = contractIndex();
  return Object.fromEntries(Object.entries(files).map(([path, value]) => [path, `${JSON.stringify(value, null, 2)}\n`]));
}
