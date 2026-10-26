import { runSearch } from "@/lib/agent-api";
import { outcomeResponse, queryArgs, readRefused } from "@/lib/agent-http";

export const dynamic = "force-dynamic";

/** GET /api/agent/search?query=…&limit=&types=update,question,evidence&from=YYYY-MM-DD&to=&language= */
export function GET(request: Request) {
  const args = queryArgs(request);
  if (args.query === undefined && args.q !== undefined) args.query = args.q;
  delete args.q;
  return readRefused(request) ?? outcomeResponse(runSearch(args), true);
}
