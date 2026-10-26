import { json, notFound, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { revokeKey } from "@/lib/app-store";
import { appPool, currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Revokes one of the reader's own keys, at once and for good. */
export async function POST(request: Request) {
  if (!appEnabled()) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);
  const user = await currentUser(request);
  if (!user) return json({ error: "signed_out" }, 401);
  const read = await readJson(request, 512);
  if (!read.ok || typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) return json({ error: "invalid" }, 400);
  const id = (read.value as Record<string, unknown>).id;
  if (typeof id !== "string" || !/^[1-9][0-9]{0,17}$/.test(id)) return json({ error: "invalid" }, 400);
  try {
    return json({ revoked: await revokeKey(appPool(), user.id, id) });
  } catch (error) {
    console.error(`[keys] revoke failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
