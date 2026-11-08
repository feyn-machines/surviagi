import { knowledgeAgent } from '@/lib/knowledge/runtime';
import { outcomeResponse, queryArgs, readRefused } from '@/lib/agent-http';

export const dynamic = 'force-dynamic';

/** HTTP counterpart of search_knowledge. Full/exact reads use /api/agent/record. */
export async function GET(request: Request) {
  const refused = readRefused(request);
  if (refused) return refused;
  return outcomeResponse(await knowledgeAgent.search(queryArgs(request)), false);
}
