import { runRecord } from "@/lib/agent-api";
import { outcomeResponse, queryArgs, readRefused } from "@/lib/agent-http";

export const dynamic = "force-dynamic";

/** GET /api/agent/record?id=…&language= */
export async function GET(request: Request) {
  const refused = readRefused(request);
  if (refused) return refused;
  return outcomeResponse(await runRecord(queryArgs(request)), true);
}
