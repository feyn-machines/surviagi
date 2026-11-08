import { createHash } from 'node:crypto';
import { KNOWLEDGE_CONTRACT_VERSION, canonical, knowledgeReferences, validateKnowledgeBundle, type KnowledgeBundle, type KnowledgeRef } from './contract';

export type KnowledgeFile = { path: string; mode: string; data: string };
export type KnowledgeArtifact = {
  format: 1; commit: string; websiteCommit: string; bundle: KnowledgeBundle;
  reverse: Record<string, KnowledgeRef[]>; indexHash: string;
};
export type ImportOptions = { commit: string; websiteCommit: string; previous?: KnowledgeArtifact };
export const refKey = (r: KnowledgeRef) => `${r.id}@${r.revision}`;
const sha = /^[a-f0-9]{40}$/;
const digest = (v: unknown) => `sha256:${createHash('sha256').update(canonical(v)).digest('hex')}`;
export function assertCommit(value: string): void {
  if (!sha.test(value)) throw new Error('Knowledge requires a full lowercase commit SHA');
}
export function parseKnowledgeJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  // JSON.parse accepts duplicate keys. Reject them instead of accepting an ambiguous publication.
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  tokens.forEach((t, i) => {
    if (t === '{') stack.push(new Set());
    else if (t === '[') stack.push(null);
    else if (t === '}' || t === ']') stack.pop();
    else if (tokens[i + 1] === ':' && t.startsWith('"')) {
      const keys = stack.at(-1); const key: string = JSON.parse(t);
      if (!keys || keys.has(key)) throw new Error('Duplicate JSON key');
      keys.add(key);
    }
  });
  return value;
}
function reverseIndex(bundle: KnowledgeBundle): Record<string, KnowledgeRef[]> {
  const reverse: Record<string, KnowledgeRef[]> = {};
  for (const e of bundle.records) for (const r of e.revisions) for (const target of knowledgeReferences(r)) {
    const list = reverse[refKey(target)] ??= [];
    if (!list.some(x => refKey(x) === refKey(r))) list.push({ id: r.id, revision: r.revision });
  }
  return reverse;
}
function makeArtifact(bundle: KnowledgeBundle, commit: string, websiteCommit: string): KnowledgeArtifact {
  const content = { format: 1 as const, commit, websiteCommit, bundle, reverse: reverseIndex(bundle) };
  return { ...content, indexHash: digest(content) };
}
export function verifyArtifact(input: unknown, commit?: string): KnowledgeArtifact {
  if (!input || typeof input !== 'object') throw new Error('Invalid knowledge artifact');
  const a = input as KnowledgeArtifact;
  assertCommit(a.commit); assertCommit(a.websiteCommit);
  if (a.format !== 1 || commit && a.commit !== commit || Object.keys(a).sort().join() !== 'bundle,commit,format,indexHash,reverse,websiteCommit') throw new Error('Knowledge artifact pin/format mismatch');
  const errors = validateKnowledgeBundle(a.bundle);
  if (errors.length) throw new Error('Invalid knowledge artifact contract');
  const expected = makeArtifact(a.bundle, a.commit, a.websiteCommit);
  if (a.indexHash !== expected.indexHash || canonical(a.reverse) !== canonical(expected.reverse)) throw new Error('Knowledge artifact hash mismatch');
  return structuredClone(expected);
}
export function importFiles(files: KnowledgeFile[], options: ImportOptions): KnowledgeArtifact {
  assertCommit(options.commit); assertCommit(options.websiteCommit);
  if (files.length > 10000) throw new Error('Knowledge file budget exceeded');
  const records = new Map<string, { id: string; head?: string; revisions: KnowledgeBundle['records'][number]['revisions'] }>();
  const seen = new Set<string>(); let total = 0; let withdrawals: unknown;
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (!['100644'].includes(file.mode) || seen.has(file.path)) throw new Error('Nonregular or duplicate knowledge file');
    seen.add(file.path);
    const size = Buffer.byteLength(file.data, 'utf8'); total += size;
    if (size > 1024 * 1024 || total > 16 * 1024 * 1024) throw new Error('Knowledge size budget exceeded');
    const match = /^(questions|cases|answers|updates)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(head\.json|revisions\/([a-f0-9]{64})\/record\.json)$/.exec(file.path);
    if (file.path !== 'withdrawals.json' && !match) throw new Error('Unexpected knowledge path');
    const value = parseKnowledgeJson(file.data);
    if (file.path === 'withdrawals.json') { withdrawals = value; continue; }
    const [, plural, slug, leaf, hash] = match!;
    const kind = plural === 'cases' ? 'case' : plural.slice(0, -1);
    const id = `knowledge:${kind}:${slug}`;
    const e = records.get(id) ?? { id, revisions: [] }; records.set(id, e);
    if (!value || typeof value !== 'object' || !('id' in value) || value.id !== id) throw new Error('Knowledge path/id mismatch');
    if (leaf === 'head.json') {
      if (Object.keys(value).sort().join() !== 'head,id' || !('head' in value) || typeof value.head !== 'string') throw new Error('Invalid head');
      e.head = value.head;
    } else {
      if (!('revision' in value) || value.revision !== `sha256:${hash}`) throw new Error('Knowledge path/hash mismatch');
      e.revisions.push(value as KnowledgeBundle['records'][number]['revisions'][number]);
    }
  }
  if (withdrawals === undefined || [...records.values()].some(e => !e.head)) throw new Error('Incomplete formal knowledge tree');
  const bundle = { contractVersion: KNOWLEDGE_CONTRACT_VERSION, records: [...records.values()], withdrawals };
  const previous = options.previous ? verifyArtifact(options.previous).bundle : undefined;
  const errors = validateKnowledgeBundle(bundle, previous);
  if (errors.length) throw new Error(`Knowledge contract/history validation failed: ${errors.join('; ')}`);
  return makeArtifact(bundle as KnowledgeBundle, options.commit, options.websiteCommit);
}
export async function importWithCache(options: ImportOptions & { fetchFiles: () => Promise<KnowledgeFile[]>; cache?: unknown | (() => unknown); cacheIndexHash?: string; onCacheUsed?: () => void }): Promise<KnowledgeArtifact> {
  assertCommit(options.commit); assertCommit(options.websiteCommit);
  let files: KnowledgeFile[];
  try { files = await options.fetchFiles(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'KNOWLEDGE_SOURCE_UNAVAILABLE') throw error;
    const cache = typeof options.cache === 'function' ? options.cache() : options.cache;
    const cached = verifyArtifact(cache, options.commit);
    if (!options.cacheIndexHash || options.cacheIndexHash !== cached.indexHash) throw new Error('Cache does not match trusted index pin');
    // Rebind website provenance for this integration, rechecking append-only history.
    const errors = validateKnowledgeBundle(cached.bundle, options.previous ? verifyArtifact(options.previous).bundle : undefined);
    if (errors.length) throw new Error('Cached knowledge violates accepted history');
    options.onCacheUsed?.();
    return makeArtifact(cached.bundle, options.commit, options.websiteCommit);
  }
  return importFiles(files, options);
}
