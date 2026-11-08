export function createFixture(seal) {
// Entirely invented test inputs. They assert contract behavior, never capability facts.
const text = () => ({ en: { title: 'Synthetic contract test', body: 'No real experiment.' }, 'zh-CN': { title: '合成契约测试', body: '不是真实实验。' } });
const unknown = () => ({ value: null, unknownReason: 'Not disclosed in this synthetic test' });
const ref = r => ({ id: r.id, revision: r.revision });
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
return fixture();
}
