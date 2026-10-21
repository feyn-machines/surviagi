import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOntology } from "./lib/ontology-release.mjs";
import { verifyPackage } from "./lib/ontology-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releases = join(root, "datasets/ontology/releases");
const entries = (await readdir(releases, { withFileTypes: true })).filter((e) => e.isDirectory() && /^v\d+\.\d+\.\d+$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
if (!entries.length) throw new Error("No sealed ontology releases found; run pnpm ontology:build");
for (const entry of entries) {
  // 1.0.0 predates the schema and is checked by its own frozen contract.
  const result = entry.name === "v1.0.0"
    ? await verifyOntology(join(releases, entry.name))
    : await verifyPackage(join(releases, entry.name));
  if (entry.name !== `v${result.manifest.version}`) throw new Error(`Ontology directory/version mismatch: ${entry.name}`);
  console.log(JSON.stringify({ release: entry.name, counts: result.counts, manifest_sha256: result.manifest_sha256 }));
}
