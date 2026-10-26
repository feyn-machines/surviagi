import { handleMcp, mcpGet } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/** MCP with the read tools and the submit tools; the submit tools need the reader's key, the read tools never do. */
export function POST(request: Request) {
  return handleMcp(request, "submit");
}

export const GET = mcpGet;
export const DELETE = mcpGet;
