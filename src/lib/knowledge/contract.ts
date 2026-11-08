import { createHash } from 'node:crypto';

/** A publication contract, deliberately independent of kg and private app questions. */
export const KNOWLEDGE_CONTRACT_VERSION = '1.0.0';
type Schema<T> = { check(value: unknown, path: string, errors: string[]): value is T };
type Value<S> = S extends Schema<infer T> ? T : never;
type Shape = Record<string, Schema<unknown>>;
const schema = <T>(check: (value: unknown, path: string, errors: string[]) => boolean): Schema<T> => ({ check: check as Schema<T>['check'] });
const fail = (errors: string[], path: string, message: string) => { errors.push(`${path}: ${message}`); return false; };
const str = schema<string>((v, p, e) => typeof v === 'string' && v.trim().length > 0 || fail(e, p, 'expected nonempty string'));
const num = schema<number>((v, p, e) => typeof v === 'number' && Number.isFinite(v) && v >= 0 || fail(e, p, 'expected finite nonnegative number'));
const bool = schema<boolean>((v, p, e) => typeof v === 'boolean' || fail(e, p, 'expected boolean'));
function object<S extends Shape>(shape: S): Schema<{ [K in keyof S]: Value<S[K]> }> {
  return schema((v, p, e) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(e, p, 'expected object');
    const data = v as Record<string, unknown>;
    let ok = true;
    for (const key of Object.keys(data)) if (!Object.hasOwn(shape, key)) { fail(e, `${p}.${key}`, 'unknown field'); ok = false; }
    for (const [key, rule] of Object.entries(shape)) if (!rule.check(data[key], `${p}.${key}`, e)) ok = false;
    return ok;
  });
}
const array = <T>(item: Schema<T>, min = 0): Schema<T[]> => schema((v, p, e) => {
  if (!Array.isArray(v) || v.length < min) return fail(e, p, `expected array with at least ${min} items`);
  let ok = true;
  v.forEach((x, i) => { if (!item.check(x, `${p}[${i}]`, e)) ok = false; });
  return ok;
});
const nullable = <T>(s: Schema<T>): Schema<T | null> => schema((v, p, e) => v === null || s.check(v, p, e));
const choice = <const T extends readonly string[]>(...values: T): Schema<T[number]> => schema((v, p, e) => typeof v === 'string' && values.includes(v) || fail(e, p, `expected ${values.join('|')}`));
const pattern = (regex: RegExp, message: string): Schema<string> => schema((v, p, e) => typeof v === 'string' && regex.test(v) || fail(e, p, message));
const id = pattern(/^knowledge:(question|case|answer|update):[a-z0-9]+(?:-[a-z0-9]+)*$/, 'invalid knowledge id');
const hash = pattern(/^sha256:[a-f0-9]{64}$/, 'invalid revision hash');
const date = schema<string>((v, p, e) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v || fail(e, p, 'invalid calendar date'));
const url = schema<string>((v, p, e) => {
  if (typeof v === 'string' && /^https:\/\//.test(v)) {
    try { const u = new URL(v); if (u.hostname && !u.username && !u.password && !/[\s<>\\]/.test(v)) return true; } catch { /* report below */ }
  }
  return fail(e, p, 'expected absolute HTTPS URL without credentials');
});
/** Unknown is explicit; null cannot silently mean zero, no human work or failure. */
const measured = <T>(value: Schema<T>) => schema<{ value: T | null; unknownReason: string | null }>((v, p, e) => {
  const base = object({ value: nullable(value), unknownReason: nullable(str) });
  if (!base.check(v, p, e)) return false;
  return (v.value === null ? v.unknownReason !== null : v.unknownReason === null) || fail(e, `${p}.unknownReason`, 'required only when value is unknown');
});
const strings = array(str);
const refSchema = object({ id, revision: hash });
export type KnowledgeRef = Value<typeof refSchema>;
const refs = array(refSchema, 1);
const report = object({ actor: str, date, scope: str, report: url });
const comparison = object({ before: refSchema, task: str, conditions: str, requirements: str, checks: str, support: refs });
const factSchemas = {
  question: object({ direction: str, work: str, context: str, deliverable: str, boundaries: array(str, 1), issue: url }),
  case: object({
    question: refSchema,
    inputs: object({ materials: str, quantity: measured(num), availability: str, missing: strings, rights: str }),
    goal: object({ deliverable: str, purpose: str, criteria: array(str, 1), checker: str, method: str }),
    method: object({ tools: array(object({ name: str, version: measured(str) }), 1), execution: str, steps: array(str, 1), promptsOrCode: measured(str) }),
    environment: object({ software: strings, hardware: measured(str), permissions: strings, network: measured(str) }),
    human: object({ preparation: measured(str), guidance: measured(str), selection: measured(str), modification: measured(str), acceptance: measured(str) }),
    result: object({ artifacts: array(object({ url, description: str, rights: str })), summary: str, checks: array(object({ criterion: str, outcome: choice('pass', 'fail', 'partial', 'not_tested', 'unknown'), detail: str, report: nullable(url) }), 1), failures: strings, untested: strings, attempts: measured(num), selection: measured(str) }),
    cost: object({ durationSeconds: measured(num), amount: measured(num), currency: measured(str), scope: str }),
    sources: array(object({ author: str, url, published: measured(date), attempted: measured(date), collected: date }), 1),
    verification: object({
      claims: array(object({ actor: str, statement: str, report: url, date }), 1),
      artifactChecks: array(report),
      reproductions: array(object({ actor: str, date, scope: str, report: url, independent: measured(bool), outcome: choice('success', 'partial', 'failure', 'unknown') })),
    }),
    conditions: array(str, 1),
  }),
  answer: object({ question: refSchema, cases: refs, judgments: array(object({ statement: str, evidence: refs }), 1), conditions: array(str, 1), canDo: strings, cannotDo: strings, unknown: strings, methods: strings, disputes: strings, gaps: strings, authors: array(str, 1), reviews: array(report, 1) }),
  update: object({ question: refSchema, answer: refSchema, cases: refs, nature: choice('new_evidence', 'capability_progress', 'scope_expansion', 'failure', 'correction', 'withdrawal', 'new_case', 'unverified', 'backfill', 'translation', 'format'), occurred: measured(date), change: str, comparison: nullable(comparison) }),
} as const;
export type KnowledgeKind = keyof typeof factSchemas;
export type KnowledgeRevision = { [K in KnowledgeKind]: {
  id: string; revision: string; kind: K; date: string;
  text: Record<'en' | 'zh-CN', { title: string; body: string }>;
  facts: Value<typeof factSchemas[K]>;
} }[KnowledgeKind];
export type KnowledgeEntity = { id: string; head: string; revisions: KnowledgeRevision[] };
export type KnowledgeWithdrawal = { target: KnowledgeRef; date: string; reason: string };
export type KnowledgeBundle = { contractVersion: typeof KNOWLEDGE_CONTRACT_VERSION; records: KnowledgeEntity[]; withdrawals: KnowledgeWithdrawal[] };
const localized = object({ title: str, body: str });
const revisionSchema = schema<KnowledgeRevision>((v, p, e) => {
  if (!v || typeof v !== 'object' || !('kind' in v) || typeof v.kind !== 'string' || !Object.hasOwn(factSchemas, v.kind)) return fail(e, `${p}.kind`, 'invalid kind');
  return object({ id, revision: hash, kind: choice(v.kind), date, text: object({ en: localized, 'zh-CN': localized }), facts: factSchemas[v.kind as KnowledgeKind] }).check(v, p, e);
});
const bundleSchema = object({ contractVersion: choice(KNOWLEDGE_CONTRACT_VERSION), records: array(object({ id, head: hash, revisions: array(revisionSchema, 1) })), withdrawals: array(object({ target: refSchema, date, reason: str })) });

/** Canonical JSON v1: recursive UTF-16 key sort; array order and string bytes preserved. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  throw new TypeError('knowledge requires JSON values');
}
export function revisionHash(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('revision must be an object');
  const content = Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'revision'));
  return `sha256:${createHash('sha256').update(canonical(content), 'utf8').digest('hex')}`;
}
const key = (r: KnowledgeRef) => `${r.id}@${r.revision}`;
/** All prose is inert Markdown: no HTML, embeds, reference links, includes or local links. */
function unsafeStrings(value: unknown, path: string, errors: string[]) {
  if (typeof value === 'string') {
    if (/<\/?[a-z!]|<!--|!\[|\]\s*\[|^\s*\[[^\]]+\]:|(?:javascript|data|vbscript|file):|https?:\/\/[^\s/]+@/im.test(value)) fail(errors, path, 'unsafe content');
    for (const match of value.matchAll(/\]\(([^)]*)\)/g)) {
      const target = match[1].trim();
      if (!url.check(target, path, [])) fail(errors, path, 'unsafe link: only plain absolute HTTPS destinations allowed');
    }
    for (const match of value.matchAll(/https:\/\/[^\s)\]>]+/g)) if (!url.check(match[0], path, [])) fail(errors, path, 'unsafe URL');
  } else if (Array.isArray(value)) value.forEach((x, i) => unsafeStrings(x, `${path}[${i}]`, errors));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, x]) => unsafeStrings(x, `${path}.${k}`, errors));
}
export function knowledgeReferences(r: KnowledgeRevision): KnowledgeRef[] {
  switch (r.kind) {
    case 'question': return [];
    case 'case': return [r.facts.question];
    case 'answer': return [r.facts.question, ...r.facts.cases, ...r.facts.judgments.flatMap(j => j.evidence)];
    case 'update': return [r.facts.question, r.facts.answer, ...r.facts.cases, ...(r.facts.comparison ? [r.facts.comparison.before, ...r.facts.comparison.support] : [])];
  }
}

/** Validate a full publication, optionally against the last accepted full publication. */
export function validateKnowledgeBundle(input: unknown, previous?: unknown): string[] {
  const errors: string[] = [];
  if (!bundleSchema.check(input, 'bundle', errors)) return errors;
  const bundle = input as KnowledgeBundle;
  unsafeStrings(bundle, 'bundle', errors);
  const entities = new Map<string, KnowledgeEntity>();
  const revisions = new Map<string, KnowledgeRevision>();
  for (const entity of bundle.records) {
    if (entities.has(entity.id)) fail(errors, entity.id, 'duplicate entity id');
    entities.set(entity.id, entity);
    for (const r of entity.revisions) {
      const path = key(r);
      if (r.id !== entity.id || r.id.split(':')[1] !== r.kind) fail(errors, path, 'id/kind does not match entity');
      if (revisions.has(path)) fail(errors, path, 'duplicate revision');
      revisions.set(path, r);
      if (revisionHash(r) !== r.revision) fail(errors, path, 'content hash mismatch');
      if (r.kind === 'question' && !/^https:\/\/github\.com\/feyn-machines\/surviagi-knowledge\/issues\/[1-9]\d*$/.test(r.facts.issue)) fail(errors, path, 'issue must be a public knowledge discussion');
    }
    if (!entity.revisions.some(r => r.revision === entity.head)) fail(errors, entity.id, 'head is not a retained revision');
  }
  const resolve = (ref: KnowledgeRef, kind?: KnowledgeKind, path = key(ref)) => {
    const target = revisions.get(key(ref));
    if (!target || kind && target.kind !== kind) { fail(errors, path, `invalid ${kind ?? ''} reference ${key(ref)}`); return undefined; }
    return target;
  };
  const withdrawn = new Set<string>();
  for (const w of bundle.withdrawals) {
    resolve(w.target);
    if (withdrawn.has(key(w.target))) fail(errors, key(w.target), 'duplicate withdrawal');
    withdrawn.add(key(w.target));
  }
  for (const r of revisions.values()) {
    const path = key(r);
    if (r.kind === 'question') continue;
    resolve(r.facts.question, 'question', path);
    const cases = r.kind === 'case' ? [] : r.facts.cases;
    for (const c of cases) {
      const target = resolve(c, 'case', path);
      if (target?.kind === 'case' && target.facts.question.id !== r.facts.question.id) fail(errors, path, 'case must concern same question');
    }
    if (r.kind === 'answer') {
      for (const j of r.facts.judgments) for (const c of j.evidence) if (!cases.some(x => key(x) === key(c))) fail(errors, path, 'judgment evidence reference must be included in cases');
    }
    if (r.kind === 'update') {
      const answer = resolve(r.facts.answer, 'answer', path);
      if (answer?.kind === 'answer') {
        if (answer.facts.question.id !== r.facts.question.id) fail(errors, path, 'answer must concern same question');
        for (const c of cases) if (!answer.facts.cases.some(x => key(x) === key(c))) fail(errors, path, 'update case reference must support its exact answer');
      }
      const needsComparison = ['capability_progress', 'scope_expansion'].includes(r.facts.nature);
      if (needsComparison && !r.facts.comparison) fail(errors, path, 'comparison is required for progress or expansion');
      if (!needsComparison && r.facts.comparison) fail(errors, path, 'comparison allowed only for progress or expansion');
      if (r.facts.comparison) {
        const c = r.facts.comparison;
        const before = resolve(c.before, 'answer', path);
        if (key(c.before) === key(r.facts.answer)) fail(errors, path, 'comparison must use distinct before and after revisions');
        if (before?.kind === 'answer' && before.facts.question.id !== r.facts.question.id) fail(errors, path, 'comparison must concern same question');
        for (const s of c.support) if (!cases.some(x => key(x) === key(s))) fail(errors, path, 'comparison support reference must be included in cases');
      }
    }
  }
  // Compute transitive dependence for every retained revision. Historical edges may
  // remain; active heads cannot expose conclusions grounded in withdrawn material.
  const affected = new Set(withdrawn);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of revisions.values()) if (!affected.has(key(r)) && knowledgeReferences(r).some(x => affected.has(key(x)))) { affected.add(key(r)); changed = true; }
  }
  const answers = new Set<string>();
  for (const entity of bundle.records) {
    const head = revisions.get(key({ id: entity.id, revision: entity.head }));
    if (!head) continue;
    if (affected.has(key(head)) && !withdrawn.has(key(head))) fail(errors, entity.id, 'active head depends on withdrawn content; withdraw it or publish a corrected revision');
    if (head.kind === 'answer') {
      if (answers.has(head.facts.question.id)) fail(errors, entity.id, 'duplicate current answer for question');
      answers.add(head.facts.question.id);
    }
  }
  if (previous !== undefined) {
    const oldErrors = validateKnowledgeBundle(previous);
    if (oldErrors.length) return [...errors, ...oldErrors.map(e => `previous: ${e}`)];
    const old = previous as KnowledgeBundle;
    for (const entity of old.records) {
      if (!entities.has(entity.id)) fail(errors, entity.id, 'history entity removed');
      for (const r of entity.revisions) {
        const current = revisions.get(key(r));
        if (!current || canonical(current) !== canonical(r)) fail(errors, key(r), 'history revision removed or rewritten');
      }
    }
    for (const w of old.withdrawals) if (!bundle.withdrawals.some(x => canonical(x) === canonical(w))) fail(errors, key(w.target), 'withdrawal removed or rewritten');
  }
  return errors;
}
