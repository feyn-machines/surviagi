import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Parser } from "n3";
import { schema, validateSchema } from "../lib/ontology-schema.mjs";
import { dataFormat, exportCounts, iris, toTurtle } from "../lib/ontology-export.mjs";
import { conformance, sealPackage, verifyPackage } from "../lib/ontology-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const v1 = join(root, "datasets/ontology/releases/v1.0.0");
const dataDir = join(root, "datasets/ontology/data");
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

async function sealed(t, change = (s) => s) {
  const dir = await mkdtemp(join(tmpdir(), "ontology-package-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, "v2.0.0");
  await sealPackage({ schema: change(structuredClone(schema)), previousDir: v1, dataDir, outputDir: out,
                      attachments: { "README.md": "t\n", "CHANGELOG.md": "t\n" } });
  return out;
}

test("the schema is valid", () => {
  assert.deepEqual(validateSchema(), []);
});

test("the export is Turtle a parser accepts, with one subject per schema item", () => {
  const quads = new Parser().parse(toTurtle());
  const typed = (type) => new Set(quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === type).map((q) => q.subject.value));
  const expected = exportCounts();
  const iri = iris();
  const bare = (text) => text.slice(1, -1);
  assert.equal(typed("http://www.w3.org/2002/07/owl#Class").has(bare(iri.class("Model"))), true);
  assert.equal([...typed("http://www.w3.org/2002/07/owl#Class")].filter((s) => s.startsWith(schema.namespace)).length, expected.classes);
  const properties = new Set([...typed("http://www.w3.org/2002/07/owl#ObjectProperty"), ...typed("http://www.w3.org/2002/07/owl#DatatypeProperty")]);
  assert.equal(properties.size, expected.properties + expected.relations);
  assert.equal(typed("http://www.w3.org/2004/02/skos/core#ConceptScheme").size, expected.vocabularies);
  assert.equal(typed("http://www.w3.org/2004/02/skos/core#Concept").size, expected.terms);
});

test("the export is deterministic and carries both languages", () => {
  assert.equal(toTurtle(), toTurtle());
  assert.match(toTurtle(), /"Model"@en, "模型"@zh-cn/);
});

test("the data format is generated from the schema's vocabularies", async () => {
  const inherited = JSON.parse(await readFile(join(v1, "schema.json"), "utf8"));
  const format = dataFormat(schema, inherited);
  const concept = format.properties.concepts.items;
  assert.deepEqual(concept.properties.kind.enum, Object.keys(schema.vocabularies.concept_kind.terms));
  assert.deepEqual(concept.properties.origin.enum, Object.keys(schema.vocabularies.concept_origin.terms));
  assert.equal(concept.required.includes("scope_note"), false);
  assert.deepEqual(format.properties.relations.items.properties.kind.enum, ["has_market", "has_work", "has_occupation", "has_task"]);
  // Reference collections are source material; their format is inherited as it was.
  assert.deepEqual(format.properties.reference_tasks, inherited.properties.reference_tasks);
  // The generated concept format accepts exactly what 1.0.0's hand-written one did.
  assert.deepEqual(Object.keys(concept.properties).sort(), Object.keys(inherited.properties.concepts.items.properties).sort());
});

test("a sealed release verifies and inherits every record of 1.0.0", async (t) => {
  const out = await sealed(t);
  const result = await verifyPackage(out, { previousDir: v1 });
  const before = JSON.parse(await readFile(join(v1, "manifest.json"), "utf8"));
  for (const name of ["concepts", "relations", "external_mappings"]) assert.equal(result.counts[name], before.counts[name]);
  const hash = (manifest, path) => manifest.files.find((f) => f.path === path).sha256;
  assert.equal(hash(result.manifest, "concepts.jsonl"), hash(before, "concepts.jsonl"));
  assert.equal(result.manifest.derived_from.version, "1.0.0");
});

test("a release is never overwritten", async (t) => {
  const out = await sealed(t);
  await assert.rejects(sealPackage({ schema, previousDir: v1, dataDir, outputDir: out, attachments: {} }), /refusing overwrite/);
});

test("an edited file is detected", async (t) => {
  const out = await sealed(t);
  await writeFile(join(out, "schema.json"), (await readFile(join(out, "schema.json"), "utf8")).replace("openaiwill", "other"));
  await assert.rejects(verifyPackage(out, { previousDir: v1 }), /hash mismatch/);
});

test("a schema that drops a concept kind cannot seal the data it no longer describes", async (t) => {
  await assert.rejects(sealed(t, (s) => { delete s.vocabularies.concept_kind.terms.occupation; return s; }), /outside its vocabulary/);
});

test("a relation must join the classes it declares", () => {
  const concepts = [{ id: "a", kind: "market", origin: "editorial_ai", translation_status: "pending", scope_status: "defined" },
                    { id: "b", kind: "work", origin: "editorial_ai", translation_status: "pending", scope_status: "defined" }];
  const relation = (kind, parent, child, view = "markets") => ({ id: "r", kind, view, parent_id: parent, child_id: child, order: 0 });
  assert.deepEqual(conformance(schema, { concepts, relations: [relation("has_work", "a", "b")] }), { concepts: 2, relations: 1 });
  assert.throws(() => conformance(schema, { concepts, relations: [relation("has_work", "b", "a")] }), /starts outside Market/);
  assert.throws(() => conformance(schema, { concepts, relations: [relation("names_model", "a", "b")] }), /undeclared kind/);
  assert.throws(() => conformance(schema, { concepts, relations: [relation("has_work", "a", "b", "occupations")] }), /wrong view/);
});
