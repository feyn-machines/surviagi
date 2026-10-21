import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}

// An internal link written as a bare string skips the language prefix, so a
// Chinese page would send its reader to the English one. Every internal link
// goes through `href()` or one of the entity helpers in src/lib/routes.ts.
test("no internal link is written as a bare path", () => {
  const offenders = [];
  for (const path of sources(SRC)) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/href=\{?\s*["'`]\//.test(line)) offenders.push(`${path.slice(SRC.length + 1)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
