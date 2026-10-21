#!/usr/bin/env node
// Guards the one property the semantic layer exists to provide: that nothing
// restates a controlled vocabulary. It re-derives every projected artefact and
// compares, and it parses the applied migrations to confirm the CHECK lists in
// the database still say exactly what the vocabularies say.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schema, termIds, currentTermIds, validateSchema, governedColumns } from "./lib/ontology-schema.mjs";
import { migrationSql, migrationSql007, migrationSql009, migrationSql011, siteLabels, marketGroups } from "./build-ontology-projections.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const fail = (message) => problems.push(message);

for (const problem of validateSchema()) fail(problem);

// 1. Generated artefacts must match what the model would produce right now.
const generated = [
  ["db/generated/006_semantic_judgment_layer.sql", migrationSql()],
  ["db/generated/007_semantic_judge_vocabulary.sql", migrationSql007()],
  ["db/generated/009_kind_check_null_repair.sql", migrationSql009()],
  ["db/generated/011_gate_state_task.sql", migrationSql011()],
  ["src/content/ontology-labels.json", JSON.stringify(siteLabels(), null, 2) + "\n"],
  ["src/content/market-groups.json", JSON.stringify(marketGroups(), null, 2) + "\n"],
];
for (const [relative, expected] of generated) {
  const path = join(root, relative);
  if (!existsSync(path)) {
    fail(`${relative} is missing; run pnpm ontology:projections`);
    continue;
  }
  if (readFileSync(path, "utf8") !== expected) {
    fail(`${relative} has drifted from the semantic model; run pnpm ontology:projections`);
  }
}

// 2. Applied migrations are frozen, so the CHECK lists in them are the contract
//    the database actually enforces. The latest definition of each governed
//    column must equal its vocabulary - not merely overlap with it.
const migrationsDir = join(root, "db", "migrations");
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const sqlByFile = new Map(migrations.map((f) => [f, readFileSync(join(migrationsDir, f), "utf8")]));

/** The lists in the LAST statement that defines this column, by file order.
 *
 * Anchored on the statement's own CREATE/ALTER target: a foreign key elsewhere
 * that references this table is not a definition of it. A conditional CHECK can
 * carry several lists (one per vocabulary marker), so all of them are returned.
 */
function checkListsFor(table, column) {
  const values = new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`, "g");
  // The statement's subject is its FIRST CREATE/ALTER TABLE target; a later
  // REFERENCES clause naming another table does not make that table the subject.
  //
  // `IF NOT EXISTS` has to be optional here. Without it every table created
  // that way was silently unmatched, and the checker reported "no CHECK list
  // found" for constraints that were sitting right there - a checker that
  // cannot see a table reports it as ungoverned, which is the same output as a
  // table that really is.
  const subject = /(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.(\w+)/;
  let latest = null;
  for (const file of migrations) {
    for (const statement of sqlByFile.get(file).split(/;\s*\n/)) {
      if (subject.exec(statement)?.[1] !== table) continue;
      const lists = [...statement.matchAll(values)].map((match) =>
        match[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")).filter(Boolean));
      if (lists.length) latest = { file, lists, statement };
    }
  }
  return latest;
}

for (const [qualified, vocabulary] of Object.entries(governedColumns)) {
  const [table, column] = qualified.split(".");
  const latest = checkListsFor(table, column);
  if (!latest) {
    fail(`${qualified} is governed by vocabulary ${vocabulary} but no CHECK list was found in db/migrations`);
    continue;
  }
  // What a row written today may carry. A retired term stays in the schema so
  // old rows can be read, and stays allowed only behind the marker of its day.
  const expected = currentTermIds(vocabulary);
  // One of the lists must be exactly the vocabulary. Other lists in the same
  // statement are the legacy branch, which only stays reachable behind a
  // *_vocabulary marker - if that marker is absent, old values are live values.
  const exact = latest.lists.find(
    (list) => list.length === expected.length && expected.every((term) => list.includes(term)));
  if (!exact) {
    const closest = latest.lists.reduce((a, b) => (b.length > a.length ? b : a), []);
    const missing = expected.filter((term) => !closest.includes(term));
    fail(`${qualified} (${latest.file}) does not enumerate vocabulary ${vocabulary}` +
         (missing.length ? `; missing ${missing.join(", ")}` : ""));
    continue;
  }
  // Other lists on the same column are fine when they only narrow the
  // vocabulary - "ai_proposed implies candidate or rejected" is a rule, not a
  // second vocabulary. A value the vocabulary does not contain is the real leak,
  // and is only legitimate behind a *_vocabulary marker that keeps old rows valid.
  const outside = latest.lists
    .filter((list) => list !== exact)
    .flat()
    .filter((value) => !expected.includes(value));
  if (outside.length && !/_vocabulary\s*=/.test(latest.statement)) {
    fail(`${qualified} (${latest.file}) allows ${[...new Set(outside)].join(", ")}, ` +
         `outside vocabulary ${vocabulary}, with no vocabulary marker to confine it`);
  }
}

// 3. Gates are instances and live outside the model.
//
//    They used to share a file with capabilities, and the capability layer took
//    that file with it. A gate is not a weak capability: it is a condition that
//    does not lift when a model improves, and it is what holds an activity at
//    L0 whatever the evidence says.
const gatesPath = join(root, "datasets", "ontology", "data", "gates.json");
if (!existsSync(gatesPath)) {
  fail("datasets/ontology/data/gates.json is missing; gates survived the capability layer");
} else {
  const gates = JSON.parse(readFileSync(gatesPath, "utf8"));
  const types = new Set(termIds("gate_type"));
  for (const gate of gates.gates ?? []) {
    if (!gate.gate_type) {
      fail(`gate ${gate.id} has no gate_type`);
    } else if (!types.has(gate.gate_type)) {
      fail(`gate ${gate.id} has gate_type ${gate.gate_type}, outside vocabulary gate_type`);
    }
    if (gate.method === "reviewed" || gate.status === "reviewed") {
      fail(`gate ${gate.id} claims reviewed status; nothing here has been confirmed by a person`);
    }
  }
}

// 4. One organisation registry, not two. This existed as a duplicated dict in
//    event_extraction.py and had already diverged; an alias only one side knew
//    silently dropped events, which is the failure rule:org-must-be-id prevents.
const orgPath = join(root, "datasets", "ontology", "data", "organizations.json");
if (!existsSync(orgPath)) {
  fail("datasets/ontology/data/organizations.json is missing");
} else {
  const organizations = JSON.parse(readFileSync(orgPath, "utf8")).organizations ?? [];
  const seen = new Map();
  const normalize = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const org of organizations) {
    for (const alias of [org.org_id, org.name_en, org.name_zh_cn, ...(org.aliases ?? [])]) {
      const key = normalize(alias);
      if (!key) continue;
      if (seen.has(key) && seen.get(key) !== org.org_id) {
        fail(`organisation alias "${alias}" is claimed by both ${seen.get(key)} and ${org.org_id}`);
      }
      seen.set(key, org.org_id);
    }
  }
  const pipeline = join(root, "scripts", "data_pipeline");
  for (const file of readdirSync(pipeline).filter((f) => f.endsWith(".py"))) {
    const source = readFileSync(join(pipeline, file), "utf8");
    // A literal org id inside a dict literal means a second registry is forming.
    if (/^\s*"org:[a-z]+":\s*\{/m.test(source)) {
      fail(`${file} declares organisation ids inline; read datasets/ontology/data/organizations.json instead`);
    }
  }
}

// 4b. The activity ladder is governed like any other vocabulary, but its column
//     is numeric, so it cannot be checked with a CHECK-IN list the way the token
//     vocabularies above are. Two guards instead: the database must permit
//     exactly the vocabulary's range, and no Python file may carry its own copy
//     of the tier caps.
//
//     This is not hypothetical. The caps lived as literals in three Python
//     places while evidence_tier.stage_cap held a DIFFERENT set for the retired
//     0-4 scale (T2 capped at 3 there, 4 here). Only T3 agreeing at 2 in both
//     kept that invisible.
{
  const levels = termIds("activity_level").map(Number);
  const top = Math.max(...levels);
  const migrations = join(root, "db", "migrations");
  let range = null;
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    const found = readFileSync(join(migrations, file), "utf8")
      .match(/observed_level\s*>=\s*(\d+)\s*AND\s*observed_level\s*<=\s*(\d+)/);
    if (found) range = { file, low: Number(found[1]), high: Number(found[2]) };
  }
  if (!range) {
    fail("no CHECK on activity_evidence.observed_level was found in db/migrations; " +
         "vocabulary activity_level governs it");
  } else if (range.low !== Math.min(...levels) || range.high !== top) {
    fail(`${range.file} permits observed_level ${range.low}-${range.high}, but vocabulary ` +
         `activity_level is ${Math.min(...levels)}-${top}`);
  }

  const capField = schema.vocabularies.activity_level.capped_by?.field;
  const pipelineDir = join(root, "scripts", "data_pipeline");
  for (const file of readdirSync(pipelineDir).filter((f) => f.endsWith(".py"))) {
    const source = readFileSync(join(pipelineDir, file), "utf8");
    // A tier mapped to a bare number, in a dict or in a SQL CASE arm.
    const literal = source.match(/["']T[1-4]["']\s*:\s*\d|WHEN\s+'T[1-4]'\s+THEN\s+\d/);
    if (literal) {
      fail(`${file} restates the evidence tier caps (${literal[0].trim()}); read them from ` +
           `evidence_tier.${capField} via ontology_schema.level_caps() (rule:tier-caps-level)`);
    }
    // The ladder's own wording, typed out instead of projected.
    if (/AI takes no part in this work\./.test(source) && file !== "ontology_schema.py") {
      fail(`${file} carries its own copy of the activity ladder; use ontology_schema.level_scale()`);
    }
  }

  // The same rule on the rendering side. work-grid.tsx used to hold all six
  // rungs in both languages - "L2 · AI produces the bulk, a person checks every
  // item" - which is the vocabulary transcribed into a component. It reads
  // correctly right up until a rung is reworded, and then the chart and the
  // method disagree with nothing reporting it. The snapshot publishes
  // progress.levels and progress.level_definitions; components read those.
  const rungs = [];
  for (const id of termIds("activity_level")) {
    const body = schema.vocabularies.activity_level.terms[id];
    for (const text of [body.label, body.definition]) {
      for (const language of Object.keys(text ?? {})) rungs.push(text[language]);
    }
  }
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith(".tsx") || full.endsWith(".ts") ? [full] : [];
  });
  for (const file of walk(join(root, "src"))) {
    const source = readFileSync(file, "utf8");
    const found = rungs.find((text) => text.length > 8 && source.includes(text));
    if (found) {
      const shown = file.slice(root.length + 1);
      fail(`${shown} carries the activity ladder's own wording ("${found}"); read it from ` +
           `progress.levels / progress.level_definitions in the published snapshot`);
    }
  }
}

// 6. The type layer stays a type layer.
//
//    rule:type-layer-has-no-state says a type carries no state, time or confidence.
//    The model used to break its own rule: `derived_content` held five capability
//    definitions, twelve candidate edges, a measurement of judge agreement and a
//    dated method journal - instances and state inside a file whose own `layers.type`
//    says its content "does not change because a news item arrived today".
//    These two checks are what stops that growing back.
if ("derived_content" in schema) {
  fail(
    "schema.json has a derived_content key again. Definitions belong in " +
    "capabilities.seed-v1.json or capabilities.discovered-v1.json, state belongs in " +
    "PostgreSQL, and the method journal belongs in docs/data/ontology-journal.md " +
    "(rule:type-layer-has-no-state)."
  );
}

const DATED_KEYS = new Set(["on", "closed_on", "as_of", "generated_at", "measured_at", "measured_over", "observed_at"]);
(function noDatedValues(node, path) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => noDatedValues(item, `${path}[${i}]`));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    // A date inside prose can be an example of a naming convention; a date as the
    // value of a dated key is a record of when something happened, which is state.
    if (DATED_KEYS.has(key)) {
      fail(`${path}.${key} records a point in time; the type layer carries none (rule:type-layer-has-no-state)`);
    }
    noDatedValues(value, `${path}.${key}`);
  }
})(schema, "schema");

if (!existsSync(join(root, "docs", "data", "ontology-journal.md"))) {
  fail("docs/data/ontology-journal.md is missing; the method journal moved there out of the model");
}

if (problems.length) {
  console.error("Ontology schema check failed:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `Ontology schema OK: ${Object.keys(schema.vocabularies).length} vocabularies, ` +
  `${schema.constraints.length} constraints, ${Object.keys(governedColumns).length} governed columns ` +
  `verified against db/migrations.`
);
