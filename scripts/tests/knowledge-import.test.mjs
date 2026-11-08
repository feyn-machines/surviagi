import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createFixture } from './knowledge-fixture.mjs';
// Load website TS directly with the same transpiler as the contract tests.
const modules = {};
for (const name of ['contract', 'importer', 'reader']) {
  let js = ts.transpileModule(readFileSync(new URL(`../../src/lib/knowledge/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [dep, url] of Object.entries(modules)) js = js.replaceAll(`'./${dep}'`, JSON.stringify(url));
  modules[name] = `data:text/javascript,${encodeURIComponent(js)}`;
}
const { revisionHash } = await import(modules.contract);
const { importFiles, verifyArtifact, importWithCache } = await import(modules.importer);
const { createKnowledgeReader, renderKnowledgeText } = await import(modules.reader);
const sha = 'a'.repeat(40), websiteCommit = 'b'.repeat(40);
const bundle = () => createFixture(r => { r.revision = revisionHash(r); return r; });
function files(b) {
  return [...b.records.flatMap(e => {
    const [ , kind, slug] = e.id.split(':'); const base = `${kind === 'case' ? 'cases' : kind + 's'}/${slug}`;
    return [{ path: `${base}/head.json`, mode: '100644', data: JSON.stringify({ id: e.id, head: e.head }) }, ...e.revisions.map(r => ({ path: `${base}/revisions/${r.revision.slice(7)}/record.json`, mode: '100644', data: JSON.stringify(r) }))];
  }), { path: 'withdrawals.json', mode: '100644', data: JSON.stringify(b.withdrawals) }];
}
const artifact = b => importFiles(files(b), { commit: sha, websiteCommit });
const baseline = () => ({ generation: 0, updatedAt: '2026-11-08T00:00:00Z', withdrawals: [], affected: [] });
const ref = r => ({ id: r.id, revision: r.revision });

test('imports pinned formal objects with retained v1 after v2 and hash-bound provenance', () => {
  const b = bundle(), old = structuredClone(b); const r = structuredClone(b.records[2].revisions[0]);
  r.text.en.body = 'Synthetic revised answer'; r.revision = revisionHash(r); b.records[2].revisions.push(r); b.records[2].head = r.revision;
  const a = importFiles(files(b), { commit: sha, websiteCommit, previous: artifact(old) });
  assert.equal(a.commit, sha); assert.equal(a.websiteCommit, websiteCommit); assert.equal(a.bundle.records.find(e => e.id === r.id).revisions.length, 2);
  verifyArtifact(a, sha);
  const corrupt = structuredClone(a); corrupt.bundle.records[0].revisions[0].text.en.body = 'changed';
  assert.throws(() => verifyArtifact(corrupt, sha));
  assert.throws(() => importFiles(files(old), { commit: sha, websiteCommit, previous: a }), /history/);
});
test('rejects non-SHA pins, path traversal, symlinks, executables, mismatched paths, unsafe Markdown and oversized input', () => {
  assert.throws(() => importFiles(files(bundle()), { commit: 'main', websiteCommit }));
  for (const patch of [{ path: '../questions/x/head.json' }, { mode: '120000' }, { mode: '100755' }, { path: 'questions/wrong/head.json' }, { data: 'x'.repeat(1024 * 1024 + 1) }]) {
    const input = files(bundle()); Object.assign(input[0], patch); assert.throws(() => importFiles(input, { commit: sha, websiteCommit }));
  }
  const b = bundle(); b.records[0].revisions[0].text.en.body = '<script>bad</script>'; b.records[0].revisions[0].revision = revisionHash(b.records[0].revisions[0]);
  assert.throws(() => artifact(b));
});
test('unavailable source uses only a verified exact-SHA cache; invalid fetched content never falls back', async () => {
  const a = artifact(bundle());
  const unavailable = async () => { const error = new Error('unavailable'); error.code = 'KNOWLEDGE_SOURCE_UNAVAILABLE'; throw error; };
  assert.deepEqual(await importWithCache({ commit: sha, websiteCommit, fetchFiles: unavailable, cache: a, cacheIndexHash: a.indexHash }), a);
  await assert.rejects(importWithCache({ commit: 'c'.repeat(40), websiteCommit, fetchFiles: unavailable, cache: a, cacheIndexHash: a.indexHash }));
  const corrupt = structuredClone(a); corrupt.indexHash = 'sha256:' + '0'.repeat(64);
  await assert.rejects(importWithCache({ commit: sha, websiteCommit, fetchFiles: unavailable, cache: corrupt, cacheIndexHash: a.indexHash }));
  await assert.rejects(importWithCache({ commit: sha, websiteCommit, fetchFiles: async () => [], cache: a }));
});
test('shared reader searches current heads in requested language and retains exact historical reads', async () => {
  const b = bundle(); const v1 = ref(b.records[0].revisions[0]); const v2 = structuredClone(b.records[0].revisions[0]);
  v2.text.en.title = 'Current synthetic question'; v2.revision = revisionHash(v2); b.records[0].revisions.push(v2); b.records[0].head = v2.revision;
  const reader = createKnowledgeReader(artifact(b), async () => baseline());
  assert.equal((await reader.get(v1, 'en')).record.text.title, 'Synthetic contract test');
  const result = await reader.search({ query: 'Current', language: 'en', kind: 'question', direction: '3d' });
  assert.equal(result.length, 1); assert.equal(result[0].revision, v2.revision); assert.equal(result[0].commit, sha);
  assert.equal((await reader.search({ query: 'Current', language: 'zh-CN' })).length, 0);
  assert.equal((await reader.search({ query: '', language: 'en', direction: 'missing' })).length, 0);
});
test('each read reloads baseline, hides exact/transitive historical bodies and new candidate dependencies', async () => {
  const b = bundle(); let state = baseline(); const a = artifact(b);
  const reader = createKnowledgeReader(a, async () => structuredClone(state));
  const target = ref(b.records[1].revisions[0]), answer = ref(b.records[2].revisions[0]);
  assert.equal((await reader.get(answer, 'en')).status, 'current');
  state = { ...state, generation: 1, withdrawals: [{ target, date: '2026-11-08', reason: 'Synthetic withdrawal' }] };
  const hidden = await reader.get(answer, 'en');
  assert.equal(hidden.status, 'withdrawn'); assert.equal(hidden.reason, 'Synthetic withdrawal');
  assert.equal(hidden.record, undefined); assert.doesNotMatch(JSON.stringify(hidden), /No capability conclusion|No real experiment/);
  assert.deepEqual((await reader.search({ query: '', language: 'en' })).map(x => x.kind), ['question']);
  const newAnswer = structuredClone(b.records[2].revisions[0]); newAnswer.text.en.body = 'New unsafe conclusion'; newAnswer.revision = revisionHash(newAnswer);
  b.records[2].revisions.push(newAnswer); b.records[2].head = newAnswer.revision;
  const candidate = createKnowledgeReader(artifact(b), async () => state);
  assert.equal((await candidate.get(ref(newAnswer), 'en')).status, 'withdrawn');
  const rollback = createKnowledgeReader(a, async () => state);
  assert.equal((await rollback.get(answer, 'en')).status, 'withdrawn');
});
test('baseline absent, malformed, duplicate, or invalid date closes get and search; caller cannot mutate reader state', async () => {
  const a = artifact(bundle()), target = ref(a.bundle.records[0].revisions[0]);
  for (const value of [null, {}, { ...baseline(), generation: -1 }, { ...baseline(), updatedAt: 'bad' }, { ...baseline(), withdrawals: [{ target, date: 'bad', reason: 'x' }] }]) {
    const reader = createKnowledgeReader(a, async () => value);
    await assert.rejects(reader.get(target, 'en')); await assert.rejects(reader.search({ query: '', language: 'en' }));
  }
  const reader = createKnowledgeReader(a, async () => baseline());
  a.bundle.records[0].revisions[0].text.en.body = 'caller mutation';
  const got = await reader.get(target, 'en'); got.record.text.body = 'response mutation';
  assert.equal((await reader.get(target, 'en')).record.text.body, 'No real experiment.');
  assert.equal(renderKnowledgeText('<img src=x> & [x](javascript:bad)'), '&lt;img src=x&gt; &amp; [x](javascript:bad)');
});

test('real Git adapter reads formal blobs, ignores executable working scripts, and rejects symlink trees', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join, dirname } = await import('node:path');
  const { execFileSync } = await import('node:child_process'); const { readGitFiles } = await import('../knowledge/git.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-git-test-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init'); git('config', 'user.name', 'Synthetic Test'); git('config', 'user.email', 'synthetic@example.org');
    for (const f of files(bundle())) { const path = join(dir, f.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, f.data); }
    writeFileSync(join(dir, 'evil.sh'), 'exit 99\n', { mode: 0o755 }); git('add', '.'); git('commit', '-m', 'Synthetic formal tree');
    const commit = git('rev-parse', 'HEAD'); const fetched = readGitFiles(dir, commit);
    assert.equal(fetched.length, 9); assert.equal(importFiles(fetched, { commit, websiteCommit }).bundle.records.length, 4);
    rmSync(join(dir, 'questions/synthetic/head.json')); symlinkSync('/etc/passwd', join(dir, 'questions/synthetic/head.json'));
    git('add', '.'); git('commit', '-m', 'Synthetic unsafe tree');
    assert.throws(() => readGitFiles(dir, git('rev-parse', 'HEAD')), /Nonregular/);
    assert.throws(() => readGitFiles(dir, '--all'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('strict JSON rejects duplicate keys and CLI failures preserve candidate bytes', async () => {
  const { parseKnowledgeJson } = await import(modules.importer);
  assert.throws(() => parseKnowledgeJson('{"x":1,"x":2}'), /Duplicate/);
  assert.throws(() => parseKnowledgeJson('{"x":1,"\\u0078":2}'), /Duplicate/);
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process'); const dir = mkdtempSync(join(tmpdir(), 'knowledge-cli-'));
  try {
    const output = join(dir, 'candidate.json'); writeFileSync(output, 'accepted candidate');
    const run = spawnSync(process.execPath, ['scripts/knowledge/import.mjs', '--commit', 'main', '--website-commit', websiteCommit, '--output', output], { encoding: 'utf8' });
    assert.equal(run.status, 1); assert.equal(readFileSync(output, 'utf8'), 'accepted candidate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('transport fallback cannot hide an invalid source tree', async () => {
  const a = artifact(bundle()); const error = new Error('Invalid Git tree');
  error.code = 'KNOWLEDGE_INVALID_SOURCE';
  await assert.rejects(importWithCache({ commit: sha, websiteCommit, cache: a, fetchFiles: async () => { throw error; } }));
});
test('corrected heads remove bad dependencies while old affected revisions remain hidden', async () => {
  const b = bundle(), oldCase = ref(b.records[1].revisions[0]), oldAnswer = ref(b.records[2].revisions[0]);
  const c = structuredClone(b.records[1].revisions[0]); c.id = 'knowledge:case:corrected'; c.text.en.body = 'Synthetic alternate evidence'; c.revision = revisionHash(c);
  b.records.push({ id: c.id, head: c.revision, revisions: [c] });
  const a = structuredClone(b.records[2].revisions[0]); a.facts.cases = [ref(c)]; a.facts.judgments[0].evidence = [ref(c)]; a.revision = revisionHash(a);
  b.records[2].revisions.push(a); b.records[2].head = a.revision;
  const state = { ...baseline(), generation: 2, withdrawals: [{ target: oldCase, date: '2026-11-08', reason: 'Synthetic withdrawal' }], affected: [oldAnswer] };
  const reader = createKnowledgeReader(artifact(b), async () => state);
  assert.equal((await reader.get(oldAnswer, 'en')).status, 'withdrawn');
  assert.equal((await reader.get(ref(a), 'en')).status, 'current');
  assert.equal((await reader.search({ query: '', language: 'en', kind: 'answer' })).length, 1);
});
test('file baseline reloads atomically replaced files and closes on missing or malformed JSON', async () => {
  const { fileBaseline } = await import(modules.reader);
  const { mkdtempSync, writeFileSync, renameSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-baseline-')); const path = join(dir, 'baseline.json');
  const b = bundle(), target = ref(b.records[0].revisions[0]);
  const reader = createKnowledgeReader(artifact(b), fileBaseline(path));
  try {
    await assert.rejects(reader.get(target, 'en'));
    writeFileSync(path, JSON.stringify(baseline())); assert.equal((await reader.get(target, 'en')).status, 'current');
    writeFileSync(join(dir, 'next.json'), JSON.stringify({ ...baseline(), generation: 1, withdrawals: [{ target, date: '2026-11-08', reason: 'Synthetic withdrawal' }] }));
    renameSync(join(dir, 'next.json'), path); assert.equal((await reader.get(target, 'en')).status, 'withdrawn');
    writeFileSync(path, '{corrupt'); await assert.rejects(reader.search({ query: '', language: 'en' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('file baseline rejects symlinks rather than reading an arbitrary target', async () => {
  const { fileBaseline } = await import(modules.reader);
  const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-baseline-link-'));
  try {
    writeFileSync(join(dir, 'real.json'), JSON.stringify(baseline())); symlinkSync('real.json', join(dir, 'link.json'));
    const reader = createKnowledgeReader(artifact(bundle()), fileBaseline(join(dir, 'link.json')));
    await assert.rejects(reader.search({ query: '', language: 'en' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('cache fallback requires an external trusted index pin even if artifact is internally valid', async () => {
  const a = artifact(bundle());
  const fetchFiles = async () => { const e = new Error('offline'); e.code = 'KNOWLEDGE_SOURCE_UNAVAILABLE'; throw e; };
  await assert.rejects(importWithCache({ commit: sha, websiteCommit, fetchFiles, cache: a }));
  await assert.rejects(importWithCache({ commit: sha, websiteCommit, fetchFiles, cache: a, cacheIndexHash: 'sha256:' + '0'.repeat(64) }));
  let used = false;
  const cached = await importWithCache({ commit: sha, websiteCommit: 'd'.repeat(40), fetchFiles, cache: a, cacheIndexHash: a.indexHash, onCacheUsed: () => { used = true; } });
  assert.equal(used, true); assert.equal(cached.websiteCommit, 'd'.repeat(40));
});
test('website-owned withdrawal reason takes precedence over content withdrawal reason', async () => {
  const b = bundle(), target = ref(b.records[3].revisions[0]);
  b.withdrawals = [{ target, date: '2026-11-08', reason: 'Content repository reason' }];
  const reader = createKnowledgeReader(artifact(b), async () => ({ ...baseline(), withdrawals: [{ target, date: '2026-11-08', reason: 'Website authoritative reason' }] }));
  assert.equal((await reader.get(target, 'en')).reason, 'Website authoritative reason');
});
test('artifact verification survives JSON object key reordering', () => {
  const a = artifact(bundle());
  const reorder = v => Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().reverse().map(k => [k, reorder(v[k])])) : v;
  assert.doesNotThrow(() => verifyArtifact(reorder(a), sha));
});
test('Git adapter rejects invalid UTF-8 and isolates inherited Git environment', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process'); const { readGitFiles } = await import('../knowledge/git.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'knowledge-git-env-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const prior = process.env.GIT_DIR;
  try {
    git('init'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.org');
    writeFileSync(join(dir, 'withdrawals.json'), '[]'); git('add', '.'); git('commit', '-m', 'Synthetic'); const commit = git('rev-parse', 'HEAD');
    process.env.GIT_DIR = join(dir, 'absent.git'); assert.equal(readGitFiles(dir, commit).length, 1);
    delete process.env.GIT_DIR;
    writeFileSync(join(dir, 'withdrawals.json'), Buffer.from([91, 34, 255, 34, 93])); git('add', '.'); git('commit', '-m', 'Invalid UTF8');
    assert.throws(() => readGitFiles(dir, git('rev-parse', 'HEAD')));
  } finally { if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior; rmSync(dir, { recursive: true, force: true }); }
});
test('unused cache is lazy; cached fallback still enforces accepted history and unknown ID baseline', async () => {
  const a = artifact(bundle()); let cacheRead = false;
  await importWithCache({ commit: sha, websiteCommit, fetchFiles: async () => files(bundle()), cache: () => { cacheRead = true; throw new Error('corrupt unused cache'); } });
  assert.equal(cacheRead, false);
  const b = bundle(); const newRevision = structuredClone(b.records[0].revisions[0]); newRevision.text.en.body = 'Synthetic newer revision'; newRevision.revision = revisionHash(newRevision); b.records[0].revisions.push(newRevision); b.records[0].head = newRevision.revision;
  const fetchFiles = async () => { const e = new Error('offline'); e.code = 'KNOWLEDGE_SOURCE_UNAVAILABLE'; throw e; };
  await assert.rejects(importWithCache({ commit: sha, websiteCommit, fetchFiles, cache: a, cacheIndexHash: a.indexHash, previous: artifact(b) }));
  const reader = createKnowledgeReader(a, async () => null);
  await assert.rejects(reader.get({ id: 'knowledge:question:absent' }, 'en'));
});
