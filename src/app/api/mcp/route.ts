import { handleMcp, mcpGet } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/** MCP with the read tools only: search, get_record, query_observations and occupation_summary, no sign-in, no key. */
export function POST(request: Request) {
  return handleMcp(request, "public");
}

export const GET = mcpGet;
export const DELETE = mcpGet;
