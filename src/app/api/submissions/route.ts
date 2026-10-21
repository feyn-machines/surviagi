import { json, notFound, rateLimit, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { createSubmission, listSubmissions, PENDING_LIMIT } from "@/lib/app-store";
import { appPool, currentUser } from "@/lib/auth";
import { normalizeHandle, OWNER_KINDS, type OwnerKind } from "@/lib/handles";
import { sources } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

const MAX_BODY = 4096;
const MAX_NOTE = 280;

export async function GET(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await currentUser(request);
  if (!user) return json({ error: "signed_out" }, 401);
  try {
    return json({ submissions: await listSubmissions(appPool(), user.id) });
  } catch (error) {
    console.error(`[submissions] list failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}

export async function POST(request: Request) {
  if (!appEnabled()) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);
  const user = await currentUser(request);
  if (!user) return json({ error: "signed_out" }, 401);
  if (!rateLimit(`submit:${user.id}`, 20, 3600_000)) return json({ error: "rate" }, 429);

  const read = await readJson(request, MAX_BODY);
  if (!read.ok) return json({ error: "invalid" }, 400);
  const body = read.value;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "invalid" }, 400);
  const fields = body as Record<string, unknown>;

  const handle = normalizeHandle(fields.handle);
  if (!handle) return json({ error: "invalid_handle" }, 400);
  if (typeof fields.ownerKind !== "string" || !(OWNER_KINDS as readonly string[]).includes(fields.ownerKind)) {
    return json({ error: "invalid_kind" }, 400);
  }
  const ownerKind = fields.ownerKind as OwnerKind;
  let note: string | null = null;
  if (fields.note !== undefined && fields.note !== null) {
    if (typeof fields.note !== "string") return json({ error: "invalid_note" }, 400);
    if (fields.note.includes("\u0000")) return json({ error: "invalid_note" }, 400);
    const trimmed = fields.note.trim();
    if ([...trimmed].length > MAX_NOTE) return json({ error: "invalid_note" }, 400);
    note = trimmed === "" ? null : trimmed;
  }

  if (sources().some((source) => (source.platform ?? "x") === "x" && source.handle.toLowerCase() === handle.key)) {
    return json({ result: "monitored", handle: handle.handle });
  }

  try {
    const created = await createSubmission(appPool(), { userId: user.id, handle: handle.handle, key: handle.key, ownerKind, note });
    if (created.result === "no_user") return json({ error: "signed_out" }, 401);
    return created.result === "limit" ? json({ result: "limit", limit: PENDING_LIMIT }) : json(created);
  } catch (error) {
    console.error(`[submissions] create failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
