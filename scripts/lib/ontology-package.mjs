// Sealing and verifying an ontology release from 2.0.0 on: the schema, the
// sealed data that conforms to it, and the two files derived from the schema.
//
// The 1.0.0 release predates the schema and is verified by its own frozen
// contract (ontology-release.mjs); this module only reads it, to prove that a
// later release still carries every one of its records.
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dataFormat, exportCounts, toTurtle } from "./ontology-export.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw new Error(message); };
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const exists = (path) => lstat(path).then(() => true, (error) => (error.code === "ENOENT" ? false : Promise.reject(error)));
const DERIVED = ["data-format.json", "ontology.ttl"];
const DATA = ["gates.json", "organizations.json"];
const ATTACHMENTS = ["README.md", "CHANGELOG.md", "market-catalog.md", "occupation-catalog.md"];

async function manifestOf(dir) {
  const bytes = await readFile(join(dir, "manifest.json"));
  const hash = digest(bytes);
  if ((await readFile(join(dir, "manifest.sha256"), "utf8")).trim() !== `${hash}  manifest.json`) fail(`manifest hash mismatch: ${dir}`);
  return { manifest: JSON.parse(bytes), manifest_sha256: hash };
}

const rowsOf = (bytes) => {
  const text = bytes.toString("utf8");
  if (text && !text.endsWith("\n")) fail("JSONL file is missing its final newline");
  return text ? text.slice(0, -1).split("\n").map((line) => JSON.parse(line)) : [];
};

/** The sealed rows against the schema: every enumerated field is a vocabulary term, every relation joins the classes it declares. */
export function conformance(schema, { concepts, relations }) {
  const terms = (name) => new Set(Object.keys(schema.vocabularies[name].terms));
  const governed = Object.entries(schema.properties)
    .filter(([, body]) => body.domain === "Concept" && body.range.startsWith("vocabulary:"))
    .map(([key, body]) => [key.split(".")[1], terms(body.range.slice(11))]);
  const kindOf = new Map();
  for (const row of concepts) {
    for (const [field, allowed] of governed) {
      if (!allowed.has(row[field])) fail(`concept ${row.id} has ${field}=${row[field]}, outside its vocabulary`);
    }
    if (kindOf.has(row.id)) fail(`duplicate concept id: ${row.id}`);
    kindOf.set(row.id, row.kind);
  }
  const classKind = Object.fromEntries(Object.entries(schema.classes).filter(([, body]) => body.kind).map(([name, body]) => [name, body.kind]));
  const seen = new Set();
  for (const row of relations) {
    const relation = schema.relations[row.kind];
    if (!relation || relation.storage !== "sealed:relations.jsonl") fail(`relation ${row.id} has undeclared kind ${row.kind}`);
    if (row.view !== relation.view) fail(`relation ${row.id} is in the wrong view`);
    if (kindOf.get(row.parent_id) !== classKind[relation.domain]) fail(`relation ${row.id} starts outside ${relation.domain}`);
    if (kindOf.get(row.child_id) !== classKind[relation.range]) fail(`relation ${row.id} ends outside ${relation.range}`);
    if (seen.has(row.id)) fail(`duplicate relation id: ${row.id}`);
    seen.add(row.id);
  }
  return { concepts: concepts.length, relations: relations.length };
}

/**
 * Seal `schema` and the data beside it as a release that inherits `previousDir`.
 * Every data file of the previous release is carried over byte for byte, which
 * is what keeping every id means.
 */
export async function sealPackage({ schema, previousDir, dataDir, outputDir, attachments }) {
  if (await exists(outputDir)) fail(`ontology release exists; refusing overwrite: ${outputDir}`);
  const previous = await manifestOf(previousDir);
  await mkdir(dirname(outputDir), { recursive: true });
  const temp = await mkdtemp(join(dirname(outputDir), `.${basename(outputDir)}-`));
  try {
    const files = [];
    const add = async (name, content, extra = {}) => {
      const bytes = Buffer.from(content);
      await writeFile(join(temp, name), bytes, { flag: "wx" });
      files.push({ path: name, bytes: bytes.length, sha256: digest(bytes), ...extra });
    };
    const counts = {};
    for (const file of previous.manifest.files.filter((f) => f.path.endsWith(".jsonl"))) {
      const bytes = await readFile(join(previousDir, file.path));
      if (digest(bytes) !== file.sha256) fail(`previous release is damaged: ${file.path}`);
      await add(file.path, bytes, { rows: file.rows, inherited_from: previous.manifest.version });
      counts[file.path.slice(0, -6)] = file.rows;
    }
    const previousFormat = JSON.parse(await readFile(join(previousDir, previous.manifest.files.some((f) => f.path === "data-format.json") ? "data-format.json" : "schema.json")));
    await add("schema.json", json(schema));
    await add("data-format.json", json(dataFormat(schema, previousFormat)));
    await add("ontology.ttl", toTurtle(schema));
    for (const name of DATA) await add(name, await readFile(join(dataDir, name)));
    for (const [name, content] of Object.entries(attachments)) {
      if (!ATTACHMENTS.includes(name)) fail(`unsupported attachment: ${name}`);
      await add(name, content);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = {
      package: "ontology", version: schema.version, schema_version: schema.version, status: "local_draft",
      created_at: new Date().toISOString(),
      derived_from: { package: "ontology", version: previous.manifest.version, manifest_sha256: previous.manifest_sha256 },
      counts, schema_counts: exportCounts(schema), files,
    };
    const bytes = json(manifest);
    await writeFile(join(temp, "manifest.json"), bytes, { flag: "wx" });
    await writeFile(join(temp, "manifest.sha256"), `${digest(bytes)}  manifest.json\n`, { flag: "wx" });
    await verifyPackage(temp, { previousDir });
    if (await exists(outputDir)) fail("ontology release exists; refusing overwrite");
    await rename(temp, outputDir);
    return manifest;
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyPackage(dir, { previousDir } = {}) {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => !e.isFile())) fail("ontology release contains something that is not a regular file");
  const { manifest, manifest_sha256 } = await manifestOf(dir);
  if (manifest.package !== "ontology" || manifest.version !== manifest.schema_version) fail("unsupported ontology package");
  const expected = [...manifest.files.map((f) => f.path), "manifest.json", "manifest.sha256"].sort();
  if (JSON.stringify(entries.map((e) => e.name).sort()) !== JSON.stringify(expected)) fail("ontology inventory has unlisted or missing files");
  const content = {};
  for (const file of manifest.files) {
    const bytes = await readFile(join(dir, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail(`ontology payload hash mismatch: ${file.path}`);
    content[file.path] = bytes;
  }
  for (const name of ["schema.json", ...DERIVED, ...DATA, "concepts.jsonl", "relations.jsonl"]) {
    if (!content[name]) fail(`ontology release is missing ${name}`);
  }
  const schema = JSON.parse(content["schema.json"]);
  if (schema.version !== manifest.version) fail("schema version does not match the release");
  for (const part of ["classes", "properties", "relations", "vocabularies", "constraints"]) {
    if (!schema[part] || typeof schema[part] !== "object") fail(`schema has no ${part}`);
  }
  // The derived files are derived: regenerating them from the sealed schema gives the same bytes.
  if (content["ontology.ttl"].toString("utf8") !== toTurtle(schema)) fail("ontology.ttl is not the export of the sealed schema");
  const counts = conformance(schema, {
    concepts: rowsOf(content["concepts.jsonl"]), relations: rowsOf(content["relations.jsonl"]),
  });
  for (const [name, n] of Object.entries(counts)) {
    if (manifest.counts[name] !== n) fail(`manifest count mismatch: ${name}`);
  }
  if (JSON.stringify(manifest.schema_counts) !== JSON.stringify(exportCounts(schema))) fail("manifest schema counts do not match the sealed schema");
  const gateTypes = new Set(Object.keys(schema.vocabularies.gate_type.terms));
  for (const gate of JSON.parse(content["gates.json"]).gates) {
    if (!gateTypes.has(gate.gate_type)) fail(`gate ${gate.id} has a gate_type outside the vocabulary`);
  }

  // Identity is inherited: every data file of the previous release is here unchanged.
  const origin = manifest.derived_from;
  const before = previousDir ?? join(dirname(dir), `v${origin.version}`);
  const previous = await manifestOf(before);
  if (previous.manifest.version !== origin.version || previous.manifest_sha256 !== origin.manifest_sha256) fail("previous release lineage mismatch");
  const here = new Map(manifest.files.map((f) => [f.path, f]));
  for (const file of previous.manifest.files.filter((f) => f.path.endsWith(".jsonl"))) {
    const carried = here.get(file.path);
    if (!carried || carried.sha256 !== file.sha256 || carried.rows !== file.rows) fail(`record identity not inherited: ${file.path}`);
  }
  const previousFormatName = previous.manifest.files.some((f) => f.path === "data-format.json") ? "data-format.json" : "schema.json";
  const previousFormat = JSON.parse(await readFile(join(before, previousFormatName)));
  if (content["data-format.json"].toString("utf8") !== json(dataFormat(schema, previousFormat))) fail("data-format.json is not derived from the sealed schema");
  return { manifest, manifest_sha256, schema, counts: manifest.counts };
}
