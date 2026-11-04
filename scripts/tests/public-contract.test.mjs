import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract, entitySchema, ENTITIES, CONTRACT_VERSION, GRADES } from "../lib/public-contract.mjs";
import { schema } from "../lib/ontology-schema.mjs";
import { makeValidator, checkSnapshot } from "../check-public-contract.mjs";

const compile = (name) => makeValidator().compile(entitySchema(ENTITIES.find((e) => e.name === name)));

const observation = () => ({
  observation_id: "obs-1", actor_key: "org:anthropic", actor_org_id: "org:anthropic", actor_person_id: null, actor_name: null,
  actor_role: "maker", subject_key: "claude-code", subject_product_id: null, subject_model_id: null, work_key: "software-development",
  event_id: null, task: "Write and test code", evidence_type: "vendor_claim", outcome: "succeeded", direction: "ai_takes_on", scale: null,
  conditions: null, occurred_on: "2026-11-01", announced_at: null, observed_at: "2026-11-02T00:00:00+00:00", review_state: "machine_proposed",
  reviewed_at: null, extractor: "extract-1", prompt_sha256: null, model: null, schema_version: "2.5.0", created_at: "2026-11-02T00:00:00+00:00",
  sources: [{ source_ref: "src-1", source_type: "x_post", url: "https://x.com/a/status/1", source_id: "1", quote: "it wrote the tests", published_at: "2026-11-01T00:00:00+00:00" }],
  facts: [],
  concerns: [{ concept_id: "w:software", kind: "work", label_en: "Software", label_zh_cn: null, method: "ai_proposed", status: "candidate" }],
  merged_from: ["obs-0"],
});

test("contract files are deterministic and every schema compiles", () => {
  const first = buildContract();
  assert.deepEqual(first, buildContract());
  for (const [path, text] of Object.entries(first)) {
    const parsed = JSON.parse(text);
    if (path.startsWith("schemas/")) makeValidator().compile(parsed);
  }
  const index = JSON.parse(first["index.json"]);
  assert.equal(index.contract_version, CONTRACT_VERSION);
  assert.equal(index.ontology_version, schema.version);
  assert.equal(index.entities.length, ENTITIES.length);
});

test("every field carries a known grade and an ontology source or a view marker", () => {
  for (const entity of ENTITIES) {
    const { properties } = entitySchema(entity);
    for (const [name, field] of Object.entries(properties)) {
      assert.ok(field["x-grade"] in GRADES, `${entity.name}.${name} grade`);
      assert.ok(field["x-ontology-property"] || field["x-shape"] === "view", `${entity.name}.${name} origin`);
    }
  }
});

test("an observation fits; a missing key, an unknown key, a bad term and a null required value do not", () => {
  const validate = compile("Observation");
  assert.ok(validate(observation()), JSON.stringify(validate.errors));
  const missing = observation();
  delete missing.task;
  assert.ok(!validate(missing), "missing key");
  assert.ok(!validate({ ...observation(), extra: 1 }), "unknown key");
  assert.ok(!validate({ ...observation(), direction: "sideways" }), "term outside the vocabulary");
  assert.ok(!validate({ ...observation(), task: null }), "null in a required (1..1) field");
  assert.ok(!validate({ ...observation(), occurred_on: "01/11/2026" }), "date format");
  assert.ok(validate({ ...observation(), concerns: [], merged_from: [] }), "unmapped and never merged");
  assert.ok(!validate({ ...observation(), merged_from: [1] }), "a redirect is an id");
  const { sources, ...withoutSources } = observation();
  assert.ok(sources.length && !validate(withoutSources), "sources is a declared key");
});

test("zero is a value and null is unknown, in the optional fields of a topic view", () => {
  const events = compile("Event");
  const row = {
    event_id: "ev-1", kind: null, kind_vocabulary: "event_kind-2.2.0", subject_key: null, title: "t", summary: "s", occurred_at: null,
    confidence: 0, identity_confidence: "high", subject: null, basis: null, task: null, result: null, quote: null, schema_version: null,
    unresolved_reason: "no kind", unresolved_class: null, primary_org_id: "org:x", org_name: "X", org_name_zh_cn: "X", facts: null, source_count: 0, source_urls: [],
    attention: {}, series_size: null, models: [], work: [],
  };
  assert.ok(events(row), JSON.stringify(events.errors));
  assert.ok(!events({ ...row, confidence: undefined }), "unknown confidence must be null, not absent");
  assert.ok(events({ ...row, announced_at: "2026-11-01T00:00:00+00:00" }), "announced_at is the one optional key");
});

test("a snapshot directory is checked row by row", () => {
  const dir = mkdtempSync(join(tmpdir(), "contract-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ counts: { models: 1 } }));
    for (const name of ["events", "sources", "topics", "work", "occupations", "observations"]) writeFileSync(join(dir, `${name}.json`), "[]");
    const model = { model_id: "m", org_id: null, level: "release", parent_model_id: null, name: "n", version: null, variant: null, status: "confirmed", released_at: null, owner: null, owner_zh_cn: null, events: 0 };
    writeFileSync(join(dir, "models.json"), JSON.stringify([model]));
    assert.deepEqual(checkSnapshot(dir), []);
    writeFileSync(join(dir, "models.json"), JSON.stringify([model, { ...model, model_id: "m2", status: "maybe" }, { ...model }]));
    const problems = checkSnapshot(dir);
    assert.ok(problems.some((p) => p.includes("m2")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("duplicate")), problems.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
