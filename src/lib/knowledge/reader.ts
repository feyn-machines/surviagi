import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { type KnowledgeKind, type KnowledgeRef, type KnowledgeRevision, type KnowledgeWithdrawal } from './contract';
import { verifyArtifact, refKey, parseKnowledgeJson, type KnowledgeArtifact } from './importer';

export type WithdrawalBaseline = { generation: number; updatedAt: string; withdrawals: KnowledgeWithdrawal[]; affected: KnowledgeRef[] };
const isRef = (v: unknown): v is KnowledgeRef => {
  if (!v || typeof v !== 'object') return false;
  const r = v as KnowledgeRef;
  return Object.keys(r).sort().join() === 'id,revision' && /^knowledge:(question|case|answer|update):[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.id) && /^sha256:[a-f0-9]{64}$/.test(r.revision);
};
export function validateBaseline(input: unknown): WithdrawalBaseline {
  if (!input || typeof input !== 'object') throw new Error('Knowledge withdrawal baseline unavailable');
  const b = input as WithdrawalBaseline;
  if (Object.keys(b).sort().join() !== 'affected,generation,updatedAt,withdrawals' || !Number.isSafeInteger(b.generation) || b.generation < 0 || typeof b.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(b.updatedAt) || !Number.isFinite(Date.parse(b.updatedAt)) || new Date(b.updatedAt).toISOString().replace('.000Z', 'Z') !== b.updatedAt.replace('.000Z', 'Z') || !Array.isArray(b.withdrawals) || !Array.isArray(b.affected)) throw new Error('Invalid knowledge withdrawal baseline');
  const seen = new Set<string>();
  for (const w of b.withdrawals) {
    if (!w || Object.keys(w).sort().join() !== 'date,reason,target' || !isRef(w.target) || typeof w.reason !== 'string' || !w.reason.trim() || w.reason.length > 1000 || !/^\d{4}-\d{2}-\d{2}$/.test(w.date) || !Number.isFinite(Date.parse(w.date)) || new Date(w.date).toISOString().slice(0, 10) !== w.date || seen.has(refKey(w.target))) throw new Error('Invalid withdrawal root');
    seen.add(refKey(w.target));
  }
  const affected = new Set<string>();
  for (const r of b.affected) {
    if (!isRef(r) || affected.has(refKey(r))) throw new Error('Invalid withdrawal impact');
    affected.add(refKey(r));
  }
  return structuredClone(b);
}
/** This path is outside code releases; never infer an empty baseline if absent. */
export function fileBaseline(path = '/opt/openaiwill/shared/knowledge-withdrawals.json'): () => Promise<unknown> {
  return async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid withdrawal baseline file');
      const bytes = await file.readFile();
      if (bytes.length > 16 * 1024 * 1024) throw new Error('Withdrawal baseline oversized');
      return parseKnowledgeJson(bytes.toString('utf8'));
    } finally { await file.close(); }
  };
}
export type KnowledgeLanguage = 'en' | 'zh-CN';
type Metadata = KnowledgeRef & { commit: string; websiteCommit: string; indexHash: string; language: KnowledgeLanguage; generation: number };
type Localized<T> = T extends KnowledgeRevision ? Omit<T, 'text'> & { text: { title: string; body: string } } : never;
type Visible = Metadata & { status: 'current' | 'superseded'; record: Localized<KnowledgeRevision> };
type Hidden = Metadata & { status: 'withdrawn'; reason: string };
export type KnowledgeRead = Visible | Hidden | (Metadata & { status: 'not_found' });
export type KnowledgeSearch = { query: string; language: KnowledgeLanguage; kind?: KnowledgeKind; direction?: string; nature?: string; limit?: number };

export function createKnowledgeReader(input: KnowledgeArtifact, loadBaseline: () => Promise<unknown> = fileBaseline()) {
  const artifact = verifyArtifact(input);
  const revisions = new Map<string, KnowledgeRevision>();
  const heads = new Map<string, string>();
  for (const e of artifact.bundle.records) { heads.set(e.id, e.head); for (const r of e.revisions) revisions.set(refKey(r), r); }
  async function context() {
    const baseline = validateBaseline(await loadBaseline());
    const hidden = new Map<string, string>();
    for (const w of [...baseline.withdrawals, ...artifact.bundle.withdrawals]) if (!hidden.has(refKey(w.target))) hidden.set(refKey(w.target), w.reason);
    for (const r of baseline.affected) if (!hidden.has(refKey(r))) hidden.set(refKey(r), 'Dependent content withdrawn');
    const pending = [...hidden.keys()];
    for (let i = 0; i < pending.length; i++) for (const dependent of artifact.reverse[pending[i]] ?? []) {
      const k = refKey(dependent);
      if (!hidden.has(k)) { hidden.set(k, hidden.get(pending[i])!); pending.push(k); }
    }
    return { baseline, hidden };
  }
  function languageCheck(language: KnowledgeLanguage) { if (language !== 'en' && language !== 'zh-CN') throw new Error('Unsupported knowledge language'); }
  function read(ref: KnowledgeRef, language: KnowledgeLanguage, ctx: Awaited<ReturnType<typeof context>>): KnowledgeRead {
    const r = revisions.get(refKey(ref));
    const meta = { ...ref, commit: artifact.commit, websiteCommit: artifact.websiteCommit, indexHash: artifact.indexHash, language, generation: ctx.baseline.generation };
    const reason = ctx.hidden.get(refKey(ref));
    if (reason !== undefined) return { ...meta, status: 'withdrawn', reason };
    if (!r) return { ...meta, status: 'not_found' };
    return { ...meta, status: heads.get(r.id) === r.revision ? 'current' : 'superseded', record: { ...structuredClone(r), text: structuredClone(r.text[language]) } as Localized<KnowledgeRevision> };
  }
  return {
    async get(ref: { id: string; revision?: string }, language: KnowledgeLanguage): Promise<KnowledgeRead> {
      languageCheck(language);
      const ctx = await context();
      return read({ id: ref.id, revision: ref.revision ?? heads.get(ref.id) ?? '' }, language, ctx);
    },
    async search(params: KnowledgeSearch) {
      languageCheck(params.language);
      if (typeof params.query !== 'string' || params.query.length > 1000 || params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100)) throw new Error('Invalid knowledge search');
      const ctx = await context(); const query = params.query.normalize('NFKC').toLowerCase();
      const results: (Metadata & { kind: KnowledgeKind; status: 'current'; title: string; summary: string; date: string })[] = [];
      for (const e of artifact.bundle.records) {
        const result = read({ id: e.id, revision: e.head }, params.language, ctx);
        if (result.status !== 'current') continue;
        const r = result.record;
        if (params.kind && r.kind !== params.kind) continue;
        if (params.nature && (r.kind !== 'update' || r.facts.nature !== params.nature)) continue;
        const question = r.kind === 'question' ? r : revisions.get(refKey(r.facts.question));
        if (params.direction && (question?.kind !== 'question' || question.facts.direction !== params.direction)) continue;
        if (!`${r.text.title}\n${r.text.body}`.normalize('NFKC').toLowerCase().includes(query)) continue;
        const meta = { id: result.id, revision: result.revision, commit: result.commit, websiteCommit: result.websiteCommit, indexHash: result.indexHash, language: result.language, generation: result.generation };
        results.push({ ...meta, status: 'current', kind: r.kind, title: r.text.title, summary: Array.from(r.text.body).slice(0, 240).join(''), date: r.date });
      }
      return results.slice(0, params.limit ?? 20);
    },
  };
}
/** Render as inert preformatted text (CSS white-space: pre-wrap); never auto-link Markdown. */
export function renderKnowledgeText(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
