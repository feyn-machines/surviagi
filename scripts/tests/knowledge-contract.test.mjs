import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/lib/knowledge/contract.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { revisionHash, validateKnowledgeBundle } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

// Entirely invented test inputs. They assert contract behavior, never capability facts.
const text = () => ({ en: { title: 'Synthetic contract test', body: 'No real experiment.' }, 'zh-CN': { title: '合成契约测试', body: '不是真实实验。' } });
const unknown = () => ({ value: null, unknownReason: 'Not disclosed in this synthetic test' });
const ref = r => ({ id: r.id, revision: r.revision });
const seal = r => { r.revision = revisionHash(r); return r; };
function fixture() {
  const q = seal({ id: 'knowledge:question:synthetic', kind: 'question', date: '2026-11-08', text: text(), facts: {
    direction: '3d', work: 'Synthetic task', context: 'Contract testing only', deliverable: 'No actual artifact', boundaries: ['Not evidence'], issue: 'https://github.com/feyn-machines/surviagi-knowledge/issues/1',
  } });
  const c = seal({ id: 'knowledge:case:synthetic', kind: 'case', date: '2026-11-08', text: text(), facts: {
    question: ref(q), inputs: { materials: 'Synthetic input description', quantity: unknown(), availability: 'Description only', missing: ['All real inputs'], rights: 'Original test description' },
    goal: { deliverable: 'Synthetic output', purpose: 'Test', criteria: ['No claim'], checker: 'Test author', method: 'Contract validation' },
    method: { tools: [{ name: 'Synthetic tool', version: unknown() }], execution: 'Not executed', steps: ['Validate contract'], promptsOrCode: unknown() },
    environment: { software: ['Synthetic'], hardware: unknown(), permissions: ['None'], network: unknown() },
    human: { preparation: unknown(), guidance: unknown(), selection: unknown(), modification: unknown(), acceptance: unknown() },
    result: { artifacts: [], summary: 'No real result', checks: [{ criterion: 'No claim', outcome: 'not_tested', detail: 'Synthetic', report: null }], failures: [], untested: ['All capability claims'], attempts: unknown(), selection: unknown() },
    cost: { durationSeconds: unknown(), amount: unknown(), currency: unknown(), scope: 'Not measured' },
    sources: [{ author: 'Test author', url: 'https://example.org/synthetic', published: unknown(), attempted: unknown(), collected: '2026-11-08' }],
    verification: { claims: [{ actor: 'Test author', statement: 'Synthetic only', report: 'https://example.org/claim', date: '2026-11-08' }], artifactChecks: [], reproductions: [] },
    conditions: ['Only for contract testing'],
  } });
  const a = seal({ id: 'knowledge:answer:synthetic', kind: 'answer', date: '2026-11-08', text: text(), facts: {
    question: ref(q), cases: [ref(c)], judgments: [{ statement: 'No capability conclusion', evidence: [ref(c)] }], conditions: ['Synthetic'], canDo: [], cannotDo: [], unknown: ['Real capability'], methods: [], disputes: [], gaps: ['Real evidence'], authors: ['Test author'], reviews: [{ actor: 'Test reviewer', date: '2026-11-08', scope: 'Synthetic contract', report: 'https://example.org/review' }],
  } });
  const u = seal({ id: 'knowledge:update:synthetic', kind: 'update', date: '2026-11-08', text: text(), facts: {
    question: ref(q), answer: ref(a), cases: [ref(c)], nature: 'new_case', occurred: unknown(), change: 'Synthetic new case', comparison: null,
  } });
  return { contractVersion: '1.0.0', records: [q, c, a, u].map(r => ({ id: r.id, head: r.revision, revisions: [r] })), withdrawals: [] };
}
const valid = b => assert.deepEqual(validateKnowledgeBundle(b), []);
const rejects = (b, pattern, previous) => assert.match(validateKnowledgeBundle(b, previous).join('\n'), pattern);
const mutate = (b, index, fn) => { const r = b.records[index].revisions[0]; fn(r); seal(r); b.records[index].head = r.revision; };

test('complete four-kind bilingual bundle accepts explicit unknowns, observed zero and unverified claims', () => {
  const b = fixture(); valid(b);
  mutate(b, 1, r => { r.facts.cost.amount = { value: 0, unknownReason: null }; });
  // Repoint dependents by rebuilding in other tests; isolated case+question is a valid subset.
  valid({ ...b, records: b.records.slice(0, 2) });
});
test('hash uses sorted object keys and binds both languages and factual fields', () => {
  const r = fixture().records[0].revisions[0];
  assert.equal(revisionHash(r), revisionHash(Object.fromEntries(Object.entries(r).reverse())));
  assert.match(r.revision, /^sha256:[a-f0-9]{64}$/);
  r.text.en.body += ' Changed'; assert.notEqual(revisionHash(r), r.revision);
});
test('rejects malformed data, unknown fields, invalid dates, and incomplete bilingual publication', () => {
  rejects(null, /bundle/);
  for (const edit of [r => delete r.text['zh-CN'], r => { r.text.en.cases = []; }, r => { r.date = '2026-02-30'; }, r => { r.facts.extra = true; }]) {
    const b = fixture(); mutate(b, 0, edit); rejects(b, /text|date|extra/);
  }
});
test('rejects duplicate entities/revisions and wrong namespace or hash', () => {
  let b = fixture(); b.records.push(structuredClone(b.records[0])); rejects(b, /duplicate/);
  b = fixture(); b.records[0].revisions.push(structuredClone(b.records[0].revisions[0])); rejects(b, /duplicate/);
  b = fixture(); b.records[0].id = 'question:private'; rejects(b, /id/);
  b = fixture(); b.records[0].revisions[0].text.en.body = 'tampered'; rejects(b, /hash/);
});
test('rejects dangling heads, wrong-kind references, and cross-question evidence', () => {
  let b = fixture(); b.records[0].head = `sha256:${'0'.repeat(64)}`; rejects(b, /head/);
  b = fixture(); mutate(b, 2, r => { r.facts.cases = [ref(b.records[0].revisions[0])]; }); rejects(b, /reference/);
  b = fixture(); mutate(b, 1, r => { r.facts.question.revision = `sha256:${'0'.repeat(64)}`; }); rejects(b, /reference/);
  b = fixture(); const q = seal({ ...structuredClone(b.records[0].revisions[0]), id: 'knowledge:question:other' });
  b.records.push({ id: q.id, head: q.revision, revisions: [q] });
  mutate(b, 2, r => { r.facts.question = ref(q); }); rejects(b, /same question/);
});
test('case requires conditions, tool version unknown reason, all human stages and separate verification dimensions', () => {
  for (const edit of [r => delete r.facts.human.selection, r => { r.facts.conditions = []; }, r => { r.facts.method.tools[0].version.unknownReason = null; }, r => { r.facts.verification.level = 'verified'; }]) {
    const b = fixture(); mutate(b, 1, edit); rejects(b, /human|conditions|unknownReason|level/);
  }
});
test('critical judgments require evidence included in the answer cases', () => {
  const b = fixture(); mutate(b, 2, r => { r.facts.judgments[0].evidence = []; }); rejects(b, /evidence/);
});
test('capability progress requires distinct before/after answers, comparable conditions and supporting cases', () => {
  const b = fixture(); mutate(b, 3, r => { r.facts.nature = 'capability_progress'; }); rejects(b, /comparison/);
  const before = structuredClone(b.records[2].revisions[0]); before.text.en.body += ' Earlier'; seal(before); b.records[2].revisions.push(before);
  mutate(b, 3, r => { r.facts.comparison = { before: ref(before), task: 'Same task', conditions: 'Same conditions', requirements: 'Same output', checks: 'Same checks', support: [ref(b.records[1].revisions[0])] }; });
  valid(b);
  mutate(b, 3, r => { r.facts.comparison.before = r.facts.answer; }); rejects(b, /distinct/);
});
test('append-only revisions preserve v1 and prohibit deletions, edits, removed entities and tombstones', () => {
  const prev = fixture(); const next = structuredClone(prev);
  const r = structuredClone(next.records[2].revisions[0]); r.text.en.body += ' Corrected'; r.text['zh-CN'].body += ' 修订'; seal(r);
  next.records[2].revisions.push(r); next.records[2].head = r.revision; valid(next);
  assert.deepEqual(validateKnowledgeBundle(next, prev), []);
  next.records[2].revisions.shift(); rejects(next, /history/, prev);
  const removed = structuredClone(prev); removed.records.pop(); rejects(removed, /history/, prev);
  const rewritten = structuredClone(prev); rewritten.records[0].revisions[0].text.en.body += ' changed'; rejects(rewritten, /history/, prev);
  const withdrawn = structuredClone(prev); withdrawn.withdrawals.push({ target: ref(prev.records[3].revisions[0]), date: '2026-11-08', reason: 'Synthetic correction' });
  valid(withdrawn); rejects(prev, /withdrawal.*removed/, withdrawn);
});
test('withdrawn evidence rejects active dependent heads but preserves history and permits corrected heads', () => {
  const b = fixture(); b.withdrawals.push({ target: ref(b.records[1].revisions[0]), date: '2026-11-08', reason: 'Synthetic withdrawal' }); rejects(b, /withdrawn/);
  b.withdrawals.push(...[2, 3].map(i => ({ target: ref(b.records[i].revisions[0]), date: '2026-11-08', reason: 'Dependent content hidden' })));
  valid(b);
  b.withdrawals[0].target.revision = `sha256:${'0'.repeat(64)}`; rejects(b, /reference/);
});
test('untrusted content rejects HTML, executable/relative links, embeds and unknown include fields', () => {
  for (const unsafe of ['<script>alert(1)</script>', '[x](javascript:alert)', '[x](../private)', '![](https://example.org/image)', '[x][ref]\n[ref]: data:text/html,x', ['https:', '//user', ':pass', '@example.org/x'].join('')]) {
    const b = fixture(); mutate(b, 0, r => { r.text.en.body = unsafe; }); rejects(b, /unsafe/);
  }
});

test('offline CLI validates initial and append-only publications, rejects corrupt JSON and symlinks', async () => {
  const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-contract-'));
  const cli = new URL('../knowledge/check.mjs', import.meta.url);
  const run = (...args) => spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' });
  try {
    const path = join(dir, 'bundle.json'); const old = join(dir, 'old.json');
    writeFileSync(path, JSON.stringify(fixture())); writeFileSync(old, JSON.stringify(fixture()));
    assert.equal(run(path).status, 0);
    assert.equal(run(path, '--previous', old).status, 0);
    const b = fixture(); b.records.pop(); writeFileSync(path, JSON.stringify(b));
    assert.equal(run(path, '--previous', old).status, 1);
    writeFileSync(path, '{ private source excerpt'); const bad = run(path);
    assert.equal(bad.status, 1); assert.doesNotMatch(bad.stderr, /private source excerpt/);
    const link = join(dir, 'link.json'); symlinkSync(old, link); assert.equal(run(link).status, 1);
    assert.equal(run().status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
