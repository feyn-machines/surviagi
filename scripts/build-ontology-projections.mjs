#!/usr/bin/env node
// Projects the ontology schema into the artefacts that must agree with it:
// the SQL constraints for migration 006 and the bilingual site labels.
// Nothing here is hand-maintained; editing an output is always wrong.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schema, termIds, term, sqlValueList, sqlValueListAt, validateSchema } from "./lib/ontology-schema.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const LEGACY_EVENT_KINDS = [
  "launch", "release", "update", "pricing", "availability",
  "benchmark", "partnership", "deprecation", "research", "other",
];
// The marker and term list of the migrations below, which have already run. A
// later version of the vocabulary gets its own marker in its own migration.
export const EVENT_KIND_VOCABULARY = "event_kind-2.0.0";
const eventKinds200 = () => sqlValueListAt("event_kind", "2.0.0");
export const LEGACY_VOCABULARY = "legacy-freeform";

const legacyList = LEGACY_EVENT_KINDS.map((k) => `'${k}'`).join(", ");

/** The migration body. Deterministic: same schema in, same bytes out.
 *
 * The SQL text mirrors migrations that are already applied and hash-locked, so its
 * comments keep the names in use when they were written (the semantic model file). */
export function migrationSql() {
  return `-- Semantic judgment layer: capability and gate type nodes, the typed judgment
-- edges from ontology concepts to them, and the instance-layer evidence and state
-- they carry. Generated from datasets/semantic/semantic-model.v2.json by
-- scripts/build-semantic-projections.mjs; every enumerated CHECK below is a
-- projection of a controlled vocabulary, never hand-typed.
--
-- Deliberately excluded: weights, and any 0-100 progress number. public.progress_values
-- stays the only place a progress estimate lives. autonomy_stage here is a different
-- axis (how independently AI can do the work, 0-4), not a second progress score, and
-- it is disjoint from adoptions.stage, which describes one adopter's rollout.
--
-- Existing rows are never rewritten. Columns that were free text keep their old
-- values under a *_vocabulary marker, so past aggregates stay reproducible while
-- new writes are constrained.
--
-- Transaction controlled by the migration runner.

-- Organisations must be referenced by id. Free-text names split silently: the
-- same company appears as 'xAI / SpaceXAI' on 14 events and 'xAI' on 9.
CREATE TABLE public.org_registry (
    org_id text PRIMARY KEY,
    canonical_name_en text NOT NULL,
    canonical_name_zh_cn text,
    aliases jsonb NOT NULL CHECK (jsonb_typeof(aliases) = 'array'),
    record_sha256 public.sha256 NOT NULL
);

-- Capability: a kind of ability work can require, independent of who performs it.
-- Stateless by construction; capability_states below carries the time-indexed part.
CREATE TABLE public.capabilities (
    capability_id text PRIMARY KEY,
    label_en text NOT NULL,
    label_zh_cn text,
    definition_en text NOT NULL,
    definition_zh_cn text,
    lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN (${sqlValueList("lifecycle")})),
    replaced_by text REFERENCES public.capabilities(capability_id),
    obsolescence_reason text,
    record_sha256 public.sha256 NOT NULL,
    CHECK (lifecycle <> 'deprecated' OR replaced_by IS NOT NULL OR obsolescence_reason IS NOT NULL),
    CHECK (replaced_by IS NULL OR replaced_by <> capability_id)
);

-- Gate: a non-capability condition that blocks autonomous completion even when
-- every required capability is met. Kept apart from capabilities so that
-- "the law did not change" is never read as "AI did not progress".
CREATE TABLE public.gates (
    gate_id text PRIMARY KEY,
    gate_type text NOT NULL CHECK (gate_type IN (${sqlValueList("gate_type")})),
    label_en text NOT NULL,
    label_zh_cn text,
    definition_en text NOT NULL,
    definition_zh_cn text,
    lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN (${sqlValueList("lifecycle")})),
    replaced_by text REFERENCES public.gates(gate_id),
    obsolescence_reason text,
    record_sha256 public.sha256 NOT NULL,
    CHECK (lifecycle <> 'deprecated' OR replaced_by IS NOT NULL OR obsolescence_reason IS NOT NULL),
    CHECK (replaced_by IS NULL OR replaced_by <> gate_id)
);

-- One row per batch of machine judgments, so every proposed edge can be traced
-- to the judge, model, prompt and rubric that produced it.
CREATE TABLE public.judgment_runs (
    run_id text PRIMARY KEY,
    judge text NOT NULL CHECK (judge IN ('deepseek', 'typesafe')),
    model text NOT NULL,
    task text NOT NULL CHECK (task IN ('requires', 'blocked_by', 'demonstrates', 'event_kind')),
    prompt_sha256 public.sha256 NOT NULL,
    rubric_sha256 public.sha256 NOT NULL,
    method_version text NOT NULL,
    params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    item_count integer CHECK (item_count IS NULL OR item_count >= 0),
    decided_count integer CHECK (decided_count IS NULL OR decided_count >= 0),
    run_sha256 public.sha256 NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    CHECK (finished_at IS NULL OR finished_at >= started_at)
);

-- requires: this work cannot be completed autonomously without this capability.
-- A structural assertion about the world, carrying no time.
CREATE TABLE public.concept_capability_edges (
    ontology_version text NOT NULL,
    from_concept_id text NOT NULL,
    capability_id text NOT NULL REFERENCES public.capabilities(capability_id),
    method text NOT NULL CHECK (method IN (${sqlValueList("relation_method")})),
    status text NOT NULL CHECK (status IN (${sqlValueList("relation_status")})),
    confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    rationale text NOT NULL,
    judgment_run_id text REFERENCES public.judgment_runs(run_id),
    reviewed_by text,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    record_sha256 public.sha256 NOT NULL,
    PRIMARY KEY (ontology_version, from_concept_id, capability_id),
    FOREIGN KEY (ontology_version, from_concept_id) REFERENCES public.ontology_concepts,
    -- A machine proposal may never present itself as settled.
    CHECK (method <> 'ai_proposed' OR status IN ('candidate', 'rejected')),
    CHECK (method <> 'ai_proposed' OR judgment_run_id IS NOT NULL),
    CHECK (method <> 'reviewed' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
    CHECK (status <> 'reviewed' OR method = 'reviewed')
);

CREATE INDEX concept_capability_edges_capability ON public.concept_capability_edges (capability_id, status);
CREATE INDEX concept_capability_edges_run ON public.concept_capability_edges (judgment_run_id);

-- blocked_by: even with every required capability, this gate still stops it.
-- because_task_id is mandatory: a gate claim must point at the task text it rests on.
CREATE TABLE public.concept_gate_edges (
    ontology_version text NOT NULL,
    from_concept_id text NOT NULL,
    gate_id text NOT NULL REFERENCES public.gates(gate_id),
    because_task_id text NOT NULL,
    method text NOT NULL CHECK (method IN (${sqlValueList("relation_method")})),
    status text NOT NULL CHECK (status IN (${sqlValueList("relation_status")})),
    confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    rationale text NOT NULL,
    judgment_run_id text REFERENCES public.judgment_runs(run_id),
    reviewed_by text,
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    record_sha256 public.sha256 NOT NULL,
    PRIMARY KEY (ontology_version, from_concept_id, gate_id),
    FOREIGN KEY (ontology_version, from_concept_id) REFERENCES public.ontology_concepts,
    FOREIGN KEY (ontology_version, because_task_id) REFERENCES public.ontology_concepts,
    CHECK (method <> 'ai_proposed' OR status IN ('candidate', 'rejected')),
    CHECK (method <> 'ai_proposed' OR judgment_run_id IS NOT NULL),
    CHECK (method <> 'reviewed' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
    CHECK (status <> 'reviewed' OR method = 'reviewed')
);

CREATE INDEX concept_gate_edges_gate ON public.concept_gate_edges (gate_id, status);

-- demonstrates: what one concrete event says about one capability, and how strongly.
-- Instance layer: events are dated evidence, so this never enters a sealed ontology.
CREATE TABLE public.capability_evidence (
    event_id text NOT NULL REFERENCES public.extracted_events(event_id),
    capability_id text NOT NULL REFERENCES public.capabilities(capability_id),
    run_id text NOT NULL REFERENCES public.judgment_runs(run_id),
    evidence_tier text NOT NULL CHECK (evidence_tier IN (${sqlValueList("evidence_tier")})),
    person_event_role text CHECK (person_event_role IS NULL OR person_event_role IN (${sqlValueList("person_event_role")})),
    evidence_sign text NOT NULL DEFAULT 'positive' CHECK (evidence_sign IN ('positive', 'negative')),
    confidence numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    rationale text NOT NULL,
    method_version text NOT NULL,
    record_sha256 public.sha256 NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, capability_id, run_id)
);

CREATE INDEX capability_evidence_capability ON public.capability_evidence (capability_id, evidence_tier);

-- The time-indexed state of a capability, recomputed rather than edited.
-- stage_cap_tier records which evidence tier limited the conclusion, so a stage
-- held down by weak evidence is distinguishable from one held down by results.
CREATE TABLE public.capability_states (
    capability_id text NOT NULL REFERENCES public.capabilities(capability_id),
    as_of timestamptz NOT NULL,
    method_version text NOT NULL,
    autonomy_stage numeric(2,1) CHECK (autonomy_stage IS NULL OR (autonomy_stage BETWEEN 0 AND 4 AND autonomy_stage * 2 = floor(autonomy_stage * 2))),
    stage_status text NOT NULL CHECK (stage_status IN ('estimated', 'insufficient_evidence')),
    stage_cap_tier text CHECK (stage_cap_tier IS NULL OR stage_cap_tier IN (${sqlValueList("evidence_tier")})),
    best_evidence_tier text CHECK (best_evidence_tier IS NULL OR best_evidence_tier IN (${sqlValueList("evidence_tier")})),
    positive_evidence_count integer NOT NULL CHECK (positive_evidence_count >= 0),
    negative_evidence_count integer NOT NULL CHECK (negative_evidence_count >= 0),
    rationale text NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now(),
    record_sha256 public.sha256 NOT NULL,
    PRIMARY KEY (capability_id, as_of, method_version),
    -- No evidence means no number. A stage is never invented to fill a gap.
    CHECK (stage_status <> 'insufficient_evidence' OR autonomy_stage IS NULL),
    CHECK (stage_status <> 'estimated' OR autonomy_stage IS NOT NULL)
);

-- Gates change when institutions change, not when models improve.
CREATE TABLE public.gate_states (
    gate_id text NOT NULL REFERENCES public.gates(gate_id),
    as_of timestamptz NOT NULL,
    method_version text NOT NULL,
    status text NOT NULL CHECK (status IN ('closed', 'partially_open', 'open')),
    rationale text NOT NULL,
    source_event_id text REFERENCES public.extracted_events(event_id),
    computed_at timestamptz NOT NULL DEFAULT now(),
    record_sha256 public.sha256 NOT NULL,
    PRIMARY KEY (gate_id, as_of, method_version)
);

-- Event kind: the old ten-word list had no definitions, so the model drew a
-- different boundary on every run (availability 15.8% -> 5.1% across two runs of
-- the same prompt) and 23.7% of events fell into "other". The controlled
-- vocabulary replaces it. Rows written under the old list keep their values and
-- are marked, so nothing silently changes meaning.
ALTER TABLE public.extracted_events ADD COLUMN kind_vocabulary text NOT NULL DEFAULT '${LEGACY_VOCABULARY}';
ALTER TABLE public.extracted_events ADD COLUMN unresolved_reason text;
ALTER TABLE public.extracted_events ADD COLUMN subject_key text;
ALTER TABLE public.extracted_events ADD COLUMN identity_confidence text;
ALTER TABLE public.extracted_events ADD COLUMN primary_org_id text REFERENCES public.org_registry(org_id);
ALTER TABLE public.extracted_events ALTER COLUMN kind DROP NOT NULL;
ALTER TABLE public.extracted_events DROP CONSTRAINT extracted_events_kind_check;
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_kind_check CHECK (
    (kind_vocabulary = '${LEGACY_VOCABULARY}' AND kind IN (${legacyList}))
    OR (kind_vocabulary = '${EVENT_KIND_VOCABULARY}' AND (
        kind IN (${eventKinds200()})
        OR (kind IS NULL AND unresolved_reason IS NOT NULL AND unresolved_reason <> '')
    ))
);
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_identity_confidence_check CHECK (
    identity_confidence IS NULL OR identity_confidence IN ('high', 'low')
);
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_new_vocabulary_needs_org CHECK (
    kind_vocabulary <> '${EVENT_KIND_VOCABULARY}' OR primary_org_id IS NOT NULL
);

CREATE INDEX extracted_events_vocabulary ON public.extracted_events (kind_vocabulary, kind);
CREATE INDEX extracted_events_org ON public.extracted_events (primary_org_id, occurred_at DESC);

-- Two more free-text columns the semantic layer governs. Same treatment: the
-- existing rows (role 'speaker', role_name '测试顾问') stay valid under their marker.
ALTER TABLE public.event_people ADD COLUMN role_vocabulary text NOT NULL DEFAULT '${LEGACY_VOCABULARY}';
ALTER TABLE public.event_people ADD CONSTRAINT event_people_role_check CHECK (
    role_vocabulary = '${LEGACY_VOCABULARY}' OR role IN (${sqlValueList("person_event_role")})
);

ALTER TABLE public.person_affiliations ADD COLUMN role_vocabulary text NOT NULL DEFAULT '${LEGACY_VOCABULARY}';
ALTER TABLE public.person_affiliations ADD CONSTRAINT person_affiliations_role_check CHECK (
    role_vocabulary = '${LEGACY_VOCABULARY}' OR role_name IN (${sqlValueList("org_affiliation_role")})
);

ALTER TABLE public.events ADD COLUMN kind_vocabulary text NOT NULL DEFAULT '${LEGACY_VOCABULARY}';
ALTER TABLE public.events ADD CONSTRAINT events_kind_check CHECK (
    kind_vocabulary = '${LEGACY_VOCABULARY}' OR kind IN (${eventKinds200()})
);
`;
}

/** Bilingual labels for every controlled vocabulary, for the website. */
export function siteLabels() {
  const vocabularies = {};
  for (const [name, vocabulary] of Object.entries(schema.vocabularies)) {
    const terms = {};
    for (const id of termIds(name)) {
      const body = term(name, id) ?? {};
      const label = body.label ?? {};
      terms[id] = {
        en: label.en ?? id.replace(/_/g, " "),
        "zh-CN": label["zh-CN"] ?? id.replace(/_/g, " "),
        definition: body.definition ?? null,
        ...(body.stage_cap !== undefined ? { stage_cap: body.stage_cap } : {}),
        ...(body.level_cap !== undefined ? { level_cap: body.level_cap } : {}),
        ...(body.implies_tier !== undefined ? { implies_tier: body.implies_tier } : {}),
        ...(body.can_demonstrate_capability !== undefined
          ? { can_demonstrate_capability: body.can_demonstrate_capability }
          : {}),
      };
    }
    vocabularies[name] = {
      label: vocabulary.label ?? { en: name, "zh-CN": name },
      terms,
    };
  }
  const labelsOf = (entries) =>
    Object.fromEntries(Object.entries(entries).filter(([, v]) => v.label).map(([k, v]) => [k, v.label]));
  return {
    generated_from: "datasets/ontology/schema/schema.json",
    schema_version: schema.version,
    classes: labelsOf(schema.classes),
    relations: labelsOf(schema.relations),
    vocabularies,
  };
}

/**
 * The market groups of the current sealed release (the one named by the schema's
 * own version) and the group each market sits in, for the homepage's domains.
 * Sorted, so the same release gives the same bytes.
 */
export function marketGroups() {
  const dir = join(root, "datasets", "ontology", "releases", `v${schema.version}`);
  const lines = (name) =>
    readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const sorted = (entries) => Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    generated_from: `datasets/ontology/releases/v${schema.version}`,
    groups: sorted(
      lines("concepts.jsonl")
        .filter((c) => c.kind === "market_group")
        .map((c) => [c.id, { en: c.label_en, zh: c.label_zh_cn ?? c.label_en }]),
    ),
    group_of_market: sorted(
      lines("relations.jsonl").filter((r) => r.kind === "has_market").map((r) => [r.child_id, r.parent_id]),
    ),
  };
}

function main() {
  const problems = validateSchema();
  if (problems.length) {
    console.error("Semantic model is invalid:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }
  mkdirSync(join(root, "db", "generated"), { recursive: true });
  mkdirSync(join(root, "src", "content"), { recursive: true });
  const sqlPath = join(root, "db", "generated", "006_semantic_judgment_layer.sql");
  writeFileSync(sqlPath, migrationSql());
  writeFileSync(join(root, "db", "generated", "007_semantic_judge_vocabulary.sql"), migrationSql007());
  writeFileSync(join(root, "db", "generated", "009_kind_check_null_repair.sql"), migrationSql009());
  writeFileSync(join(root, "db", "generated", "011_gate_state_task.sql"), migrationSql011());
  const labelsPath = join(root, "src", "content", "ontology-labels.json");
  writeFileSync(labelsPath, JSON.stringify(siteLabels(), null, 2) + "\n");
  const groupsPath = join(root, "src", "content", "market-groups.json");
  writeFileSync(groupsPath, JSON.stringify(marketGroups(), null, 2) + "\n");
  console.log(`Wrote ${sqlPath}`);
  console.log(`Wrote ${join(root, "db", "generated", "007_semantic_judge_vocabulary.sql")}`);
  console.log(`Wrote ${labelsPath}`);
  console.log(`Wrote ${groupsPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

/**
 * 007 exists because 006 hard-coded the judge and task lists instead of
 * projecting them. Re-issuing the constraints from the vocabularies removes the
 * second source of truth; applied migrations are hash-frozen, so a correction is
 * always a new file rather than an edit.
 */
export function migrationSql007() {
  return `-- Bring judgment_runs.judge and judgment_runs.task under the controlled
-- vocabularies. 006 wrote both lists literally, which is exactly the duplication
-- the semantic layer exists to remove, and it omitted 'interactive_review' — the
-- source of every capability, gate and edge currently proposed.
-- Generated from datasets/semantic/semantic-model.v2.json.
-- Transaction controlled by the migration runner.

ALTER TABLE public.judgment_runs DROP CONSTRAINT judgment_runs_judge_check;
ALTER TABLE public.judgment_runs ADD CONSTRAINT judgment_runs_judge_check
    CHECK (judge IN (${sqlValueList("judge")}));

ALTER TABLE public.judgment_runs DROP CONSTRAINT judgment_runs_task_check;
ALTER TABLE public.judgment_runs ADD CONSTRAINT judgment_runs_task_check
    CHECK (task IN (${sqlValueList("judgment_task")}));
`;
}

/**
 * 009 fixes a three-valued-logic hole in the CHECK 006 generated.
 *
 * `kind IN ('a','b')` is NULL when kind is NULL, so `(marker = 'x' AND NULL)`
 * is NULL, `NULL OR FALSE` is NULL, and PostgreSQL accepts a row whose CHECK
 * evaluated to unknown. The constraint that was supposed to force an
 * unresolved_reason onto every unclassified event accepted rows without one.
 * Caught by an integration test, not by review.
 */
export function migrationSql009() {
  return `-- Repair extracted_events_kind_check: it never rejected anything with a NULL
-- kind. In SQL, NULL IN (...) is NULL, not false, so the intended
-- "unclassified events must say why" rule evaluated to unknown and passed.
-- Every branch below now tests IS NULL / IS NOT NULL explicitly.
-- Generated from datasets/semantic/semantic-model.v2.json.
-- Transaction controlled by the migration runner.

ALTER TABLE public.extracted_events DROP CONSTRAINT extracted_events_kind_check;
ALTER TABLE public.extracted_events ADD CONSTRAINT extracted_events_kind_check CHECK (
    (kind_vocabulary = '${LEGACY_VOCABULARY}'
        AND kind IS NOT NULL AND kind IN (${legacyList}))
    OR (kind_vocabulary = '${EVENT_KIND_VOCABULARY}' AND (
        (kind IS NOT NULL AND kind IN (${eventKinds200()}))
        OR (kind IS NULL AND unresolved_reason IS NOT NULL AND unresolved_reason <> '')
    ))
);

-- The same shape of hole in the two role constraints: a NULL role passed both.
ALTER TABLE public.event_people DROP CONSTRAINT event_people_role_check;
ALTER TABLE public.event_people ADD CONSTRAINT event_people_role_check CHECK (
    role_vocabulary = '${LEGACY_VOCABULARY}'
    OR (role IS NOT NULL AND role IN (${sqlValueList("person_event_role")}))
);

ALTER TABLE public.person_affiliations DROP CONSTRAINT person_affiliations_role_check;
ALTER TABLE public.person_affiliations ADD CONSTRAINT person_affiliations_role_check CHECK (
    role_vocabulary = '${LEGACY_VOCABULARY}'
    OR (role_name IS NOT NULL AND role_name IN (${sqlValueList("org_affiliation_role")}))
);

ALTER TABLE public.events DROP CONSTRAINT events_kind_check;
ALTER TABLE public.events ADD CONSTRAINT events_kind_check CHECK (
    kind_vocabulary = '${LEGACY_VOCABULARY}'
    OR (kind IS NOT NULL AND kind IN (${eventKinds200()}))
);
`;
}

/**
 * 011 adds gate_state to judgment_runs.task.
 *
 * Gate-state runs had been recorded as 'demonstrates' because that CHECK had no
 * better value. The evidence query then picked the most recent completed
 * 'demonstrates' run, found a gate-state run, and published a snapshot with zero
 * evidence rows. Borrowing a vocabulary term is not untidiness; downstream reads
 * it at face value.
 */
export function migrationSql011() {
  return `-- Add gate_state to the judgment task vocabulary. Generated from
-- datasets/semantic/semantic-model.v2.json.
-- Transaction controlled by the migration runner.

ALTER TABLE public.judgment_runs DROP CONSTRAINT judgment_runs_task_check;
ALTER TABLE public.judgment_runs ADD CONSTRAINT judgment_runs_task_check
    CHECK (task IN (${sqlValueList("judgment_task")}));
`;
}
