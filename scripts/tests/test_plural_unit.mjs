import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = async (relative) => {
  const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(js)}`);
};
const { plural } = await load("../../src/lib/plural.ts");

// 2026-10-16: the live English pages read "1 updates bear on it", "1 tasks carry a level", "1 pieces of evidence".
test("one takes the singular form, every other count the plural", () => {
  const say = "{n} {n|update bears|updates bear} on it.";
  assert.equal(plural(say, { n: 1 }), "{n} update bears on it.");
  assert.equal(plural(say, { n: 0 }), "{n} updates bear on it.");
  assert.equal(plural(say, { n: 3 }), "{n} updates bear on it.");
});

test("a formatted number is read as the number it shows", () => {
  const t = "{n|piece|pieces}";
  assert.equal(plural(t, { n: "1" }), "piece");
  assert.equal(plural(t, { n: "1,001" }), "pieces");
  assert.equal(plural(t, { n: "11" }), "pieces");
});

test("several keys agree each with their own count", () => {
  const t = "{n} {n|kind|kinds} of work in {m} {m|market|markets}";
  assert.equal(plural(t, { n: 1, m: 3 }), "{n} kind of work in {m} markets");
  assert.equal(plural(t, { n: 4, m: 1 }), "{n} kinds of work in {m} market");
});

test("a token without its value stays visible, and text without tokens is untouched", () => {
  assert.equal(plural("{n|one|many}", {}), "{n|one|many}");
  assert.equal(plural("截至 {date}，{n} 条证据", { n: 1 }), "截至 {date}，{n} 条证据");
});
