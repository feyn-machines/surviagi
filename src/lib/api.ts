/** Shared pieces of the JSON route handlers under `/api/`. */

/** Every response that carries or depends on a user must send these. */
export const NO_STORE_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } as const;

/** A JSON answer that no cache may keep and no search engine may index. */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

export function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

/** True when the request names an `Origin` equal to the origin of `BETTER_AUTH_URL`; false when that is unset or malformed. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const site = process.env.BETTER_AUTH_URL;
  if (!origin || !site) return false;
  try {
    return new URL(origin).origin === new URL(site).origin;
  } catch {
    return false;
  }
}

/**
 * Reads a JSON body without buffering more than `maxBytes`: refuses on a larger `Content-Length`
 * and stops reading as soon as more than `maxBytes` has arrived.
 */
export async function readJson(request: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return { ok: false };
  if (!request.body) return { ok: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false };
  }
}

const hits = new Map<string, number[]>();

/** In-memory, per process. Returns false once `key` has made `limit` calls within `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  for (const [name, times] of hits) {
    const recent = times.filter((time) => now - time < windowMs);
    if (recent.length === 0) hits.delete(name);
    else if (name !== key) hits.set(name, recent);
  }
  const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}
