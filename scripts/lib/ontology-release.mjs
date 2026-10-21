import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ontologyCollections, ontologyModel, ontologySchema } from "./ontology-data-format.mjs";
import { validateOntology } from "./ontology-data.mjs";

export const ontologyVersion = "1.0.0";
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw new Error(message); };
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const attachmentNames = new Set(["README.md", "market-catalog.md", "occupation-catalog.md", "coverage-report.json", "CHANGELOG.md"]);
const requiredNames = [...ontologyCollections.map((name) => `${name}.jsonl`), "model.json", "schema.json"];
const payloadNames = new Set([...requiredNames, ...attachmentNames]);
const exists = async (path) => lstat(path).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) fail(`invalid ${label} fields`);
}
function checkOrigin(origin) {
  exactKeys(origin, ["package", "version", "manifest_sha256"], "source provenance");
  if (origin.package !== "platform" || typeof origin.version !== "string" || typeof origin.manifest_sha256 !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(origin.version) || !/^[a-f0-9]{64}$/.test(origin.manifest_sha256)) fail("invalid source provenance");
}
function checkManifest(manifest) {
  exactKeys(manifest, ["package", "version", "schema_version", "status", "created_at", "derived_from", "counts", "files"], "manifest");
  if (manifest.package !== "ontology" || manifest.version !== ontologyVersion || manifest.schema_version !== ontologyVersion || manifest.status !== "local_draft") fail("unsupported ontology package or contract version");
  const time = new Date(manifest.created_at);
  if (typeof manifest.created_at !== "string" || !Number.isFinite(time.valueOf()) || time.toISOString() !== manifest.created_at) fail("invalid manifest created_at");
  checkOrigin(manifest.derived_from);
  exactKeys(manifest.counts, ontologyCollections, "manifest counts");
  if (!Object.values(manifest.counts).every((n) => Number.isSafeInteger(n) && n >= 0)) fail("invalid manifest counts");
  if (!Array.isArray(manifest.files)) fail("missing manifest file inventory");
  const seen = new Set();
  for (const file of manifest.files) {
    exactKeys(file, ["path", "bytes", "sha256", "rows"], "manifest file");
    if (!payloadNames.has(file.path)) fail(`unsafe or unsupported inventory path: ${file.path}`);
    if (seen.has(file.path)) fail(`duplicate manifest inventory path: ${file.path}`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) fail("invalid manifest file integrity metadata");
    if (file.path.endsWith(".jsonl") ? !Number.isSafeInteger(file.rows) || file.rows < 0 : file.rows !== null) fail("invalid manifest row count");
  }
  if (requiredNames.some((name) => !seen.has(name))) fail("manifest inventory is missing required ontology payload");
}

export async function sealOntology({ data, outputDir, derivedFrom, attachments = {} }) {
  if (await exists(outputDir)) fail(`ontology release exists; refusing overwrite: ${outputDir}`);
  const { counts } = validateOntology(data);
  checkOrigin(derivedFrom);
  for (const [name, content] of Object.entries(attachments)) {
    if (!attachmentNames.has(name) || typeof content !== "string") fail(`unsupported ontology attachment: ${name}`);
  }
  await mkdir(dirname(outputDir), { recursive: true });
  const lockPath = `${outputDir}.lock`;
  const lock = await open(lockPath, "wx");
  let temp;
  try {
    if (await exists(outputDir)) fail("ontology release exists; refusing overwrite");
    temp = await mkdtemp(join(dirname(outputDir), `.${basename(outputDir)}-`));
    const files = [];
    const add = async (name, content, rows = null) => {
      const bytes = Buffer.from(content);
      await writeFile(join(temp, name), bytes, { flag: "wx" });
      files.push({ path: name, bytes: bytes.length, sha256: digest(bytes), rows });
    };
    for (const name of ontologyCollections) await add(`${name}.jsonl`, data[name].map((r) => JSON.stringify(r) + "\n").join(""), data[name].length);
    await add("model.json", json(ontologyModel));
    await add("schema.json", json(ontologySchema));
    for (const [name, content] of Object.entries(attachments)) await add(name, content);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = {
      package: "ontology", version: ontologyVersion, schema_version: ontologyVersion,
      status: "local_draft", created_at: new Date().toISOString(),
      derived_from: derivedFrom, counts, files,
    };
    const bytes = json(manifest);
    await writeFile(join(temp, "manifest.json"), bytes, { flag: "wx" });
    await writeFile(join(temp, "manifest.sha256"), `${digest(bytes)}  manifest.json\n`, { flag: "wx" });
    await verifyOntology(temp);
    if (await exists(outputDir)) fail("ontology release exists; refusing overwrite");
    await rename(temp, outputDir);
    temp = null;
    return manifest;
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function verifyOntology(dir) {
  const root = await lstat(dir);
  if (!root.isDirectory() || root.isSymbolicLink()) fail("ontology release must be a regular directory");
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => !e.isFile())) fail("ontology release contains a non-regular file or symlink");
  const manifestBytes = await readFile(join(dir, "manifest.json"));
  const manifestHash = digest(manifestBytes);
  if ((await readFile(join(dir, "manifest.sha256"), "utf8")).trim() !== `${manifestHash}  manifest.json`) fail("manifest hash integrity mismatch");
  const manifest = JSON.parse(manifestBytes);
  checkManifest(manifest);
  const expected = [...manifest.files.map((f) => f.path), "manifest.json", "manifest.sha256"].sort();
  if (!isDeepStrictEqual(entries.map((e) => e.name).sort(), expected)) fail("ontology inventory has unlisted or missing files");
  const data = {};
  for (const file of manifest.files) {
    const bytes = await readFile(join(dir, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail(`ontology payload hash integrity mismatch: ${file.path}`);
    if (file.path === "model.json" && !isDeepStrictEqual(JSON.parse(bytes), ontologyModel)) fail("altered or unsupported ontology model");
    if (file.path === "schema.json" && !isDeepStrictEqual(JSON.parse(bytes), ontologySchema)) fail("altered or unsupported ontology schema contract");
    if (file.path.endsWith(".jsonl")) {
      const text = bytes.toString("utf8");
      if (text && !text.endsWith("\n")) fail(`ontology JSONL missing newline: ${file.path}`);
      const rows = text ? text.slice(0, -1).split("\n").map((line) => JSON.parse(line)) : [];
      if (rows.length !== file.rows) fail(`ontology row count mismatch: ${file.path}`);
      data[file.path.slice(0, -6)] = rows;
    }
  }
  const result = validateOntology(data);
  if (!isDeepStrictEqual(result.counts, manifest.counts)) fail("ontology manifest count summary mismatch");
  return { ...result, data, manifest, manifest_sha256: manifestHash };
}
