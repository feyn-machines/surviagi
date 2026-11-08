import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createFixture } from './knowledge-fixture.mjs';
const modules = {};
for (const name of ['contract', 'importer', 'reader', 'agent', 'runtime']) {
  let js = ts.transpileModule(readFileSync(new URL(`../../src/lib/knowledge/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [dep, url] of Object.entries(modules)) js = js.replaceAll(`'./${dep}'`, JSON.stringify(url));
  modules[name] = `data:text/javascript,${encodeURIComponent(js)}`;
}
const { revisionHash } = await import(modules.contract);
const { importFiles } = await import(modules.importer);
const { createKnowledgeReader, renderKnowledgeText } = await import(modules.reader);
const { createKnowledgeAgent } = await import(modules.agent);
function setup(commit = 'a'.repeat(40)) {
  const b = createFixture(r => ({ ...r, revision: revisionHash(r) }));
  const old = structuredClone(b.records[0].revisions[0]);
  const current = structuredClone(old); current.text.en.title = 'Current synthetic question'; current.revision = revisionHash(current);
  b.records[0].revisions.push(current); b.records[0].head = current.revision;
  const files = b.records.flatMap(e => {
    const [, kind, slug] = e.id.split(':'); const base = `${kind === 'case' ? 'cases' : kind + 's'}/${slug}`;
    return [{ path: `${base}/head.json`, mode: '100644', data: JSON.stringify({ id: e.id, head: e.head }) }, ...e.revisions.map(r => ({ path: `${base}/revisions/${r.revision.slice(7)}/record.json`, mode: '100644', data: JSON.stringify(r) }))];
  });
  files.push({ path: 'withdrawals.json', mode: '100644', data: '[]' });
  const artifact = importFiles(files, { commit, websiteCommit: 'b'.repeat(40) });
  let baseline = { generation: 0, updatedAt: '2026-11-08T00:00:00Z', withdrawals: [], affected: [] };
  const reader = createKnowledgeReader(artifact, async () => baseline);
  return { b, old, reader, artifact, agent: createKnowledgeAgent(async () => reader), setBaseline(v) { baseline = v; } };
}
test('bilingual search paginates all heads with shared filters and no cache', async () => {
  const { agent, reader } = setup();
  const first = await agent.search({ query: 'synthetic', limit: '2' });
  assert.equal(first.ok, true); assert.equal(first.cacheable, false);
  assert.equal(first.value.total, 4); assert.equal(first.value.results.length, 2);
  const next = await agent.search({ query: 'synthetic', limit: 2, cursor: first.value.next_cursor });
  assert.equal(next.value.results.length, 2); assert.equal(next.value.next_cursor, null);
  assert.equal(new Set([...first.value.results, ...next.value.results].map(r => r.id)).size, 4);
  const zh = await agent.search({ query: '合成', language: 'zh-CN', kind: 'case', direction: '3d' });
  assert.deepEqual(zh.value.results, await reader.search({ query: '合成', language: 'zh-CN', kind: 'case', direction: '3d' }));
  assert.equal((await agent.search({ query: 'synthetic', nature: 'new_case' })).value.total, 1);
});
test('exact old revision has identical facts and localized body to webpage/Markdown shared source', async () => {
  const { old, agent, reader } = setup();
  for (const language of ['en', 'zh-CN']) {
    const got = await agent.get({ id: old.id, revision: old.revision, language });
    assert.equal(got.ok, true); assert.equal(got.cacheable, false);
    assert.deepEqual(got.value, await reader.get(old, language));
    assert.equal(got.value.status, 'superseded');
    assert.equal(renderKnowledgeText(got.value.record.text.body), renderKnowledgeText(old.text[language].body));
    const c = await agent.get({ id: 'knowledge:case:synthetic', language });
    assert.deepEqual(c.value.record.facts.conditions, ['Only for contract testing']);
    assert.equal(c.value.record.facts.sources[0].url, 'https://example.org/synthetic');
  }
});
test('validates bounds, filters, ids, revision, language and mismatched cursors', async () => {
  const { agent } = setup();
  for (const args of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }, { language: 'fr' }, { query: 'x'.repeat(1001) }, { kind: 'topic' }, { nature: 'bogus' }, { direction: {} }, { cursor: 'bad' }]) {
    assert.equal((await agent.search({ query: 'synthetic', ...args })).status, 400);
  }
  const page = await agent.search({ query: 'synthetic', limit: 1 });
  assert.equal((await agent.search({ query: 'different', cursor: page.value.next_cursor })).status, 400);
  for (const args of [{ id: 'topic:old' }, { id: 'knowledge:case:synthetic', revision: 'main' }, { id: 'knowledge:case:synthetic', language: 'fr' }]) assert.equal((await agent.get(args)).status, 400);
  assert.equal((await agent.get({ id: 'knowledge:case:missing' })).status, 404);
});
test('withdrawal propagates to agent reads, invalidates cursor and baseline failure closes both', async () => {
  const { b, agent, setBaseline } = setup();
  const page = await agent.search({ query: 'synthetic', limit: 1 });
  const c = b.records[1].revisions[0];
  setBaseline({ generation: 1, updatedAt: '2026-11-08T01:00:00Z', withdrawals: [{ target: { id: c.id, revision: c.revision }, date: '2026-11-08', reason: 'Synthetic withdrawal' }], affected: [] });
  const got = await agent.get({ id: 'knowledge:answer:synthetic' });
  assert.equal(got.value.status, 'withdrawn'); assert.equal(got.value.record, undefined);
  assert.doesNotMatch(JSON.stringify(got), /No capability conclusion/);
  assert.equal((await agent.search({ query: 'synthetic', cursor: page.value.next_cursor })).status, 400);
  assert.equal((await agent.search({ query: 'synthetic' })).value.total, 1);
  setBaseline(null);
  assert.equal((await agent.search({ query: 'synthetic' })).status, 503);
  assert.equal((await agent.get({ id: c.id })).status, 503);
});
test('missing local artifact fails closed without fetching', async () => {
  const agent = createKnowledgeAgent(async () => { throw Error('not installed'); });
  assert.equal((await agent.search({ query: 'synthetic' })).status, 503);
  assert.equal((await agent.get({ id: 'knowledge:case:synthetic' })).status, 503);
});

test('cursor is bound to artifact and empty results still report provenance', async () => {
  const { agent } = setup();
  const page = await agent.search({ query: 'synthetic', limit: 1 });
  const other = setup('c'.repeat(40)).agent;
  assert.equal((await other.search({ query: 'synthetic', cursor: page.value.next_cursor })).status, 400);
  const empty = await agent.search({ query: 'missing' });
  assert.equal(empty.value.total, 0); assert.equal(empty.value.commit, 'a'.repeat(40));
  assert.equal(empty.value.language, 'en'); assert.equal(empty.value.generation, 0);
  assert.equal(empty.value.next_cursor, null);
  assert.equal((await agent.get({ id: 'knowledge:case:synthetic', revision: 'sha256:' + '0'.repeat(64) })).status, 404);
});

test('verified artifact reader is reused while baseline remains live and file replacement invalidates it', async () => {
  const { mkdtempSync, writeFileSync, renameSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { loadKnowledgeReader } = await import(modules.runtime);
  const { artifact, b } = setup(); const dir = mkdtempSync(join(tmpdir(), 'knowledge-runtime-'));
  const artifactPath = join(dir, 'artifact.json'), baselinePath = join(dir, 'baseline.json');
  const previous = [process.env.KNOWLEDGE_ARTIFACT_PATH, process.env.KNOWLEDGE_WITHDRAWALS_PATH];
  process.env.KNOWLEDGE_ARTIFACT_PATH = artifactPath; process.env.KNOWLEDGE_WITHDRAWALS_PATH = baselinePath;
  writeFileSync(artifactPath, JSON.stringify(artifact));
  const baseline = { generation: 0, updatedAt: '2026-11-08T00:00:00Z', withdrawals: [], affected: [] };
  writeFileSync(baselinePath, JSON.stringify(baseline));
  try {
    const first = await loadKnowledgeReader();
    assert.equal(await loadKnowledgeReader(), first, 'unchanged validated artifact reuses the reader');
    const c = b.records[1].revisions[0];
    writeFileSync(baselinePath, JSON.stringify({ ...baseline, generation: 1, withdrawals: [{ target: { id: c.id, revision: c.revision }, date: '2026-11-08', reason: 'Synthetic withdrawal' }] }));
    assert.equal((await (await loadKnowledgeReader()).get({ id: b.records[2].id }, 'en')).status, 'withdrawn');
    writeFileSync(artifactPath + '.tmp', JSON.stringify(artifact)); renameSync(artifactPath + '.tmp', artifactPath);
    assert.notEqual(await loadKnowledgeReader(), first, 'atomic artifact replacement revalidates');
    writeFileSync(artifactPath, '{}'); await assert.rejects(loadKnowledgeReader());
    rmSync(artifactPath); await assert.rejects(loadKnowledgeReader());
  } finally {
    for (const [i, name] of ['KNOWLEDGE_ARTIFACT_PATH', 'KNOWLEDGE_WITHDRAWALS_PATH'].entries()) {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
test('record language normalization retains legacy aliases', async () => {
  const { agent } = setup();
  for (const language of ['zh-cn', 'ZH-CN', ' zh-CN ']) assert.equal((await agent.get({ id: 'knowledge:case:synthetic', language })).value.language, 'zh-CN');
  assert.equal((await agent.get({ id: 'knowledge:case:synthetic', language: null })).value.language, 'en');
});
