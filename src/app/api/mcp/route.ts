import { handleMcp, mcpGet } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/** MCP with the read tools only: search and get_record, no sign-in, no key. */
export function POST(request: Request) {
  return handleMcp(request, "public");
}

export const GET = mcpGet;
export const DELETE = mcpGet;
