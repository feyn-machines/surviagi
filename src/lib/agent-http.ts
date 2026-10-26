import { NO_STORE_HEADERS, readJson } from "./api";
import { RATE_MESSAGE, readAllowed, type Outcome } from "./agent-api";

/**
 * The plain HTTP form of the agent tools, for a Skill or a script that does not speak MCP. Reads are public
 * and may be cached for a minute by anyone; everything that names a reader is no-store.
 */

const PUBLIC_HEADERS = { "Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex" } as const;

export function outcomeResponse(outcome: Outcome, cacheable: boolean): Response {
  if (outcome.ok) return Response.json(outcome.value, { headers: cacheable ? PUBLIC_HEADERS : NO_STORE_HEADERS });
  return Response.json({ error: outcome.error, message: outcome.message, ...(outcome.extra ?? {}) }, { status: outcome.status, headers: NO_STORE_HEADERS });
}

/** Query parameters as tool arguments; `types` may repeat or be comma-separated. */
export function queryArgs(request: Request): Record<string, unknown> {
  const params = new URL(request.url).searchParams;
  const args: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    args[key] = key === "types" ? values.join(",") : values[values.length - 1];
  }
  return args;
}

export function readRefused(request: Request): Response | null {
  return readAllowed(request) ? null : Response.json({ error: "rate", message: RATE_MESSAGE }, { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": "60" } });
}

/** A JSON object body of at most 16 KB, or null. */
export async function bodyArgs(request: Request): Promise<Record<string, unknown> | null> {
  const read = await readJson(request, 16 * 1024);
  if (!read.ok || typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) return null;
  return read.value as Record<string, unknown>;
}

export const INVALID_BODY: Outcome = { ok: false, status: 400, error: "invalid", message: "The body must be one JSON object of at most 16 KB." };
