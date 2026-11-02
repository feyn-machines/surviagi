import { runSummary } from "@/lib/agent-api";
import { outcomeResponse, queryArgs, readRefused } from "@/lib/agent-http";

export const dynamic = "force-dynamic";

/** GET /api/agent/summary?occupation=…|market=…&language= */
export async function GET(request: Request) {
  const refused = readRefused(request);
  if (refused) return refused;
  return outcomeResponse(runSummary(queryArgs(request)), true);
}
