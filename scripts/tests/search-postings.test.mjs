import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
const source = readFileSync(new URL("../../src/lib/search-postings.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { SearchPostings } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("release index preserves substring matches across scripts, punctuation and repeated grams", () => {
  const texts = ["会计 accounting audit", "软件 developer c++ c#", "abc bcd cde", "ababa", "😀 deployment", "", "account\ning"];
  const index = new SearchPostings(texts);
  const queries = ["", "会", "会计", "account", "c++", "#", "abcde", "ababa", "abababa", "😀", "\ude00", "missing", "account\ning"];
  // Every substring of every fixture, plus negatives: no false negatives or gram-only false positives.
  for (const text of texts) for (let a = 0; a < text.length; a++) for (let b = a + 1; b <= text.length; b++) queries.push(text.slice(a, b));
  for (const q of queries) assert.deepEqual([...index.find(q)].sort((a,b) => a-b), texts.flatMap((t,id) => t.includes(q) ? [id] : []), q);
  assert.deepEqual([...index.any(["会计", "developer", "absent"])].sort(), [0, 1]);
});

test("a new release has isolated postings and does not retain removed records", () => {
  const old = new SearchPostings(["会计", "developer"]);
  const current = new SearchPostings(["developer", "auditor"]);
  assert.deepEqual([...old.find("会计")], [0]);
  assert.deepEqual([...current.find("会计")], []);
  assert.deepEqual([...current.find("developer")], [0]);
});

test("indexed ranking equals a full scan for bilingual evaluation queries and filters", async () => {
  const agentSource = readFileSync(new URL("../../src/lib/agent-search.ts", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace("function corpus()", "function unusedCorpus()");
  const compiled = ts.transpileModule(agentSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  // Inject a corpus into the actual production ranker; the reference index only scans.
  const factory = await import(`data:text/javascript,${encodeURIComponent(`let fixture; const corpus = () => fixture; const manifest = () => null; const dataRelease = () => ({releaseId:'test'}); const absoluteUrl = (l,p) => l+p; export const setFixture = (f) => fixture=f;\n${compiled}`)}`);
  const questions = JSON.parse(readFileSync(new URL("./fixtures/search-eval.json", import.meta.url))).questions;
  const docs = questions.flatMap((q, i) => [q.query, `${q.query} 会计 audit developer`].map((text, j) => ({
    id: `${i}-${j}`, type: j ? "observation" : "question", title: text, snippet: text, content: "machine_summary",
    date: i % 2 ? "2026-11-01" : null, organization: null, sources: [], path: "/x", markdownPath: "/x/raw.md",
    fields: [{ name: "title", text: text.normalize("NFKC").toLowerCase(), weight: 3 }],
  })));
  const texts = docs.map((d) => d.fields[0].text);
  const scan = { find: (q) => new Set(texts.flatMap((t,i) => t.includes(q) ? [i] : [])), any(qs) { return new Set(qs.flatMap((q) => [...this.find(q)])); } };
  const indexed = new SearchPostings(texts);
  const fixture = { docs, lexicon: new Set(["会计", "程序员"]), aliases: new Map() };
  for (const q of questions) for (const filters of [{}, {types:["observation"], from:"2026-10-01"}, {to:"2026-10-01"}]) {
    const input = {query:q.query, language:q.language, ...filters};
    factory.setFixture({...fixture, index:scan});
    const expected = factory.rankedSearch(input);
    factory.setFixture({...fixture, index:indexed});
    assert.deepEqual(factory.rankedSearch(input), expected, JSON.stringify(input));
  }
});
