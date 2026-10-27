import { runSearch } from "@/lib/agent-api";
import { outcomeResponse, queryArgs, readRefused } from "@/lib/agent-http";

export const dynamic = "force-dynamic";

/** GET /api/agent/search?query=…&limit=&types=update,question,evidence,article&status=approved|preview&from=&to=&language= */
export async function GET(request: Request) {
  const args = queryArgs(request);
  if (args.query === undefined && args.q !== undefined) args.query = args.q;
  delete args.q;
  const refused = readRefused(request);
  if (refused) return refused;
  return outcomeResponse(await runSearch(args), true);
}
