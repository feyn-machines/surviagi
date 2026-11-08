import { KnowledgeCursorError, type createKnowledgeReader, type KnowledgeLanguage } from './reader';
import type { KnowledgeKind } from './contract';
import type { Outcome } from '../agent-api';

type Reader = ReturnType<typeof createKnowledgeReader>;
type Args = Record<string, unknown>;
const kinds = ['question', 'case', 'answer', 'update'] as const;
const natures = ['new_evidence', 'capability_progress', 'scope_expansion', 'failure', 'correction', 'withdrawal', 'new_case', 'unverified', 'backfill', 'translation', 'format'];
const idPattern = /^knowledge:(question|case|answer|update):[a-z0-9]+(?:-[a-z0-9]+)*$/;
const invalid = (message: string): Outcome => ({ ok: false, status: 400, error: 'invalid', message });
const unavailable = (): Outcome => ({ ok: false, status: 503, error: 'unavailable', message: 'Knowledge reading is unavailable. No research or collection was started.' });
const success = (value: Record<string, unknown>): Outcome => ({ ok: true, value, cacheable: false });
function language(args: Args): KnowledgeLanguage | null {
  if (args.language === undefined || args.language === null) return 'en';
  if (typeof args.language !== 'string') return null;
  const tag = args.language.trim().toLowerCase();
  return tag === 'en' ? 'en' : tag === 'zh-cn' ? 'zh-CN' : null;
}
/** HTTP and MCP use this adapter; the page/Markdown source remains the same reader. */
export function createKnowledgeAgent(load: () => Promise<Reader>) {
  return {
    async search(args: Args): Promise<Outcome> {
      const lang = language(args);
      if (!lang) return invalid('language must be en or zh-CN.');
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000) return invalid('query must contain 1-1000 characters.');
      const limit = args.limit === undefined ? 20 : typeof args.limit === 'string' ? Number(args.limit) : args.limit;
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return invalid('limit must be an integer from 1 to 100.');
      if (args.kind !== undefined && !kinds.includes(args.kind as KnowledgeKind)) return invalid('kind must be question, case, answer or update.');
      if (args.nature !== undefined && !natures.includes(args.nature as string)) return invalid('Invalid update nature.');
      if (args.direction !== undefined && (typeof args.direction !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.direction) || args.direction.length > 100)) return invalid('Invalid direction slug.');
      if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 200)) return invalid('Invalid cursor.');
      try {
        const reader = await load();
        return success(await reader.searchPage({ query: args.query.trim(), language: lang, limit, kind: args.kind as KnowledgeKind | undefined, direction: args.direction as string | undefined, nature: args.nature as string | undefined, cursor: args.cursor as string | undefined }));
      } catch (error) {
        return error instanceof KnowledgeCursorError ? invalid(error.message) : unavailable();
      }
    },
    async get(args: Args): Promise<Outcome> {
      const lang = language(args);
      if (!lang) return invalid('language must be en or zh-CN.');
      if (typeof args.id !== 'string' || args.id.length > 260 || !idPattern.test(args.id)) return invalid('Invalid knowledge id.');
      if (args.revision !== undefined && (typeof args.revision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(args.revision))) return invalid('revision must be an exact sha256 revision.');
      try {
        const reader = await load();
        const result = await reader.get({ id: args.id, revision: args.revision as string | undefined }, lang);
        return result.status === 'not_found' ? { ok: false, status: 404, error: 'not_found', message: 'No knowledge record with this exact id/revision.' } : success(result);
      } catch { return unavailable(); }
    },
  };
}
export const KNOWLEDGE_SEARCH_TOOL = {
  name: 'search_knowledge', title: 'Search case-answer knowledge',
  description: 'Search current question/case/answer/update heads from the pinned knowledge version, in English or Chinese. Separate from legacy questions and private user requests. Use get_record with id and revision for full conditions, sources, facts and body. No models or collection. Withdrawn content is excluded. Pass next_cursor for another page; restart when it expires.',
  inputSchema: { type: 'object', properties: {
    query: { type: 'string', minLength: 1, maxLength: 1000 },
    language: { type: 'string', enum: ['en', 'zh-CN'], default: 'en' },
    kind: { type: 'string', enum: kinds }, direction: { type: 'string', maxLength: 100 },
    nature: { type: 'string', enum: natures },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, cursor: { type: 'string', maxLength: 200 },
  }, required: ['query'], additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
} as const;
