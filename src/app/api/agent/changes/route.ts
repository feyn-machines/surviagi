import { runChanges } from "@/lib/agent-api";
import { outcomeResponse, queryArgs, readRefused } from "@/lib/agent-http";

export const dynamic = "force-dynamic";

/** GET /api/agent/changes?since=<release id|YYYY-MM-DD|time>&occupation=|market=&limit=&language= */
export async function GET(request: Request) {
  const refused = readRefused(request);
  if (refused) return refused;
  return outcomeResponse(await runChanges(queryArgs(request)), true);
}
