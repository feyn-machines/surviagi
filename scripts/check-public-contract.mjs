#!/usr/bin/env node
// Checks a published snapshot against the public data contract. A snapshot whose rows
// do not fit the schema of the entity they claim to be is refused before it can become
// a data release: `node scripts/check-public-contract.mjs [snapshot-dir]`.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { ENTITIES, RETIRED_COLLECTIONS, CONTRACT_PATH } from "./lib/public-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractDir = join(root, "public", ...CONTRACT_PATH.split("/"));

const FORMATS = {
  "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  uri: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i,
};

export function makeValidator() {
  const ajv = new Ajv2020({ allErrors: false, strict: false, validateFormats: true });
  for (const [name, pattern] of Object.entries(FORMATS)) ajv.addFormat(name, (value) => pattern.test(value));
  return ajv;
}

/** Problems of one snapshot directory: unknown files, rows that break their entity's schema. */
export function checkSnapshot(directory, { limit = 5 } = {}) {
  const problems = [];
  const ajv = makeValidator();
  const dir = resolve(directory);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return [`no manifest.json in ${dir}`];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const known = new Set([...ENTITIES.map((e) => e.collection).filter(Boolean), ...RETIRED_COLLECTIONS.map((c) => c.file), "manifest"]);
  for (const entity of ENTITIES.filter((e) => e.collection)) {
    const file = join(dir, `${entity.collection}.json`);
    if (!existsSync(file)) {
      problems.push(`${entity.collection}.json is missing (entity ${entity.name})`);
      continue;
    }
    const schemaPath = join(contractDir, "schemas", `${entity.name}.schema.json`);
    if (!existsSync(schemaPath)) {
      problems.push(`${entity.name}: schema file missing, run pnpm ontology:projections`);
      continue;
    }
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
    const rows = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(rows)) {
      problems.push(`${entity.collection}.json must be a JSON array of ${entity.name}`);
      continue;
    }
    const seen = new Set();
    let bad = 0;
    for (const [index, row] of rows.entries()) {
      const id = row?.[entity.id];
      if (typeof id === "string") {
        if (seen.has(id)) problems.push(`${entity.collection}.json: duplicate ${entity.id} ${id}`);
        seen.add(id);
      }
      if (validate(row)) continue;
      bad += 1;
      if (bad <= limit) {
        const error = validate.errors[0];
        problems.push(`${entity.collection}.json[${index}] (${id ?? "no id"}): ${error.instancePath || "row"} ${error.message}${error.params?.additionalProperty ? ` (${error.params.additionalProperty})` : ""}`);
      }
    }
    if (bad > limit) problems.push(`${entity.collection}.json: ${bad - limit} more rows break the ${entity.name} schema`);
  }
  for (const key of Object.keys(manifest.counts ?? {})) {
    const file = key.split(".")[0];
    if (!known.has(file) && !ENTITIES.some((e) => e.collection === file)) problems.push(`manifest counts ${key}, which no contract entity or retired collection covers`);
  }
  return problems;
}

function main() {
  const directory = process.argv[2] ?? join(root, "datasets", "published", "latest");
  const problems = checkSnapshot(directory);
  if (problems.length) {
    console.error(`Snapshot ${directory} does not satisfy the public data contract:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`Snapshot ${directory} satisfies public data contract ${JSON.parse(readFileSync(join(contractDir, "index.json"), "utf8")).contract_version}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
