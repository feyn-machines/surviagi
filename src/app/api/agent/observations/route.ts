import { runQueryObservations } from "@/lib/agent-api";
import { outcomeResponse, queryArgs, readRefused } from "@/lib/agent-http";

export const dynamic = "force-dynamic";

/** GET /api/agent/observations?occupation=&market=&task=&organization=&subject=&evidence_types=&directions=&outcomes=&review_states=&from=&to=&order=&limit=&cursor=&language= */
export async function GET(request: Request) {
  const refused = readRefused(request);
  if (refused) return refused;
  return outcomeResponse(runQueryObservations(queryArgs(request)), true);
}
