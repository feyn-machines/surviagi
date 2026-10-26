import { runRecord } from "@/lib/agent-api";
import { outcomeResponse, queryArgs, readRefused } from "@/lib/agent-http";

export const dynamic = "force-dynamic";

/** GET /api/agent/record?id=…&language= */
export function GET(request: Request) {
  return readRefused(request) ?? outcomeResponse(runRecord(queryArgs(request)), true);
}
