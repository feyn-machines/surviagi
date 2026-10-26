import { readJson } from "./api";
import { RATE_MESSAGE, READ_TOOLS, readAllowed, runTool, SUBMIT_TOOLS, type Outcome } from "./agent-api";
import { absoluteUrl, SITE_NAME, SITE_URL } from "./seo";

/**
 * A Model Context Protocol server over Streamable HTTP, stateless: every POST carries one JSON-RPC message and
 * gets one JSON answer. There is no session, no server-sent stream and no server-to-client request, so GET is
 * 405, as the transport allows. Two endpoints serve it: `/api/mcp` with the read tools only, for a connector
 * that holds no key, and `/api/mcp/submit` with the submit tools too, for one that sends the reader's key
 * (WorkBuddy applies a connector's authentication to every call it makes, so the two must be separate).
 */

/** Newest first; an unknown version asked for in `initialize` is answered with the first. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-11-25", "2025-03-26", "2024-11-05"] as const;
const MAX_BODY = 64 * 1024;
const VERSION = "1.0.0";

type Scope = "public" | "submit";
type Id = string | number | null;

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } as const;

const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const rpcError = (id: Id, code: number, message: string, status = 200) =>
  answer({ jsonrpc: "2.0", id, error: { code, message } }, status);

function instructions(scope: Scope) {
  const lines = [
    `${SITE_NAME} (${SITE_URL}) tracks progress toward AI independently completing major production and service work, from official updates.`,
    "Use search, then get_record for detail. Every level and summary is machine-proposed and unreviewed; cite the record url with the release's generated_at, and quote the original sources, not our summaries.",
    "The site retrieves and registers; it does not answer. Analysis and conclusions are yours, and must say what the records do not cover.",
  ];
  if (scope === "submit") {
    lines.push(
      "With the reader's key: submit_question registers a research question for review (search first; say why it matters and what is missing), suggest_account registers an X account to monitor, my_submissions shows status and quota. Use a request_id so a retry does not register twice. Nothing is researched or collected automatically.",
    );
  } else {
    lines.push(`Submitting questions or accounts needs the reader's API key and the endpoint ${SITE_URL}/api/mcp/submit; see ${absoluteUrl("en", "/agents")}.`);
  }
  return lines.join("\n");
}

function toolResult(outcome: Outcome) {
  if (outcome.ok) {
    return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], structuredContent: outcome.value };
  }
  const value = { error: outcome.error, message: outcome.message, ...(outcome.extra ?? {}) };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

/** Answers one HTTP request to an MCP endpoint. */
export async function handleMcp(request: Request, scope: Scope): Promise<Response> {
  // No Origin check: the transport's rule guards local servers against DNS rebinding, and this one is public,
  // reads only published data and authenticates by a Bearer key, never by a cookie. A desktop client may send an
  // Origin of its own; a browser page on another site gets no CORS headers and cannot pass the preflight.
  const version = request.headers.get("mcp-protocol-version");
  if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${version}`, 400);
  }
  if (!readAllowed(request)) return rpcError(null, -32000, RATE_MESSAGE, 429);

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return rpcError(null, -32700, "Parse error: the body must be one JSON-RPC message of at most 64 KB", 400);
  const message = read.value;
  if (Array.isArray(message)) return rpcError(null, -32600, "Batches are not supported; send one message per request", 400);
  if (typeof message !== "object" || message === null) return rpcError(null, -32600, "Invalid request", 400);
  const { jsonrpc, id, method, params } = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (jsonrpc !== "2.0") return rpcError(null, -32600, "Invalid request: jsonrpc must be \"2.0\"", 400);
  // A notification or a response to us: accepted, nothing to say.
  if (id === undefined || typeof method !== "string") return new Response(null, { status: 202, headers: HEADERS });
  if (typeof id !== "string" && typeof id !== "number") return rpcError(null, -32600, "Invalid request: bad id", 400);
  const p = (typeof params === "object" && params !== null && !Array.isArray(params) ? params : {}) as Record<string, unknown>;

  switch (method) {
    case "initialize": {
      const asked = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
      return answer({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: scope === "submit" ? "surviagi-submit" : "surviagi", title: SITE_NAME, version: VERSION, websiteUrl: SITE_URL },
          instructions: instructions(scope),
        },
      });
    }
    case "ping":
      return answer({ jsonrpc: "2.0", id, result: {} });
    case "tools/list":
      return answer({ jsonrpc: "2.0", id, result: { tools: scope === "submit" ? [...READ_TOOLS, ...SUBMIT_TOOLS] : [...READ_TOOLS] } });
    case "tools/call": {
      const name = typeof p.name === "string" ? p.name : "";
      const args = typeof p.arguments === "object" && p.arguments !== null && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
      const outcome = await runTool(request, name, args, scope);
      if (!outcome) {
        const hint = scope === "public" && SUBMIT_TOOLS.some((tool) => tool.name === name) ? ` ${name} is on ${SITE_URL}/api/mcp/submit, with an API key.` : "";
        return rpcError(id, -32602, `Unknown tool: ${name || "(none)"}.${hint}`);
      }
      return answer({ jsonrpc: "2.0", id, result: toolResult(outcome) });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function mcpGet(): Response {
  return new Response(JSON.stringify({ error: "This MCP endpoint takes POST (Streamable HTTP, JSON responses, no stream)." }), {
    status: 405,
    headers: { ...HEADERS, Allow: "POST", "Content-Type": "application/json" },
  });
}
