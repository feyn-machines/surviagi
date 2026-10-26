import { json, notFound, rateLimit, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { createKey, listKeys, MAX_ACTIVE_KEYS, usage } from "@/lib/app-store";
import { appPool, currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const MAX_BODY = 1024;
const MAX_NAME = 60;

/** The signed-in reader's API keys (never their secrets) and quota use. */
export async function GET(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await currentUser(request);
  if (!user) return json({ error: "signed_out" }, 401);
  try {
    const db = appPool();
    const [keys, use] = await Promise.all([listKeys(db, user.id), usage(db, user.id)]);
    return json({ keys, usage: use, maxActive: MAX_ACTIVE_KEYS });
  } catch (error) {
    console.error(`[keys] list failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}

/** Makes a key; the answer is the only place its secret ever appears. */
export async function POST(request: Request) {
  if (!appEnabled()) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);
  const user = await currentUser(request);
  if (!user) return json({ error: "signed_out" }, 401);
  if (!rateLimit(`keys:${user.id}`, 10, 3600_000)) return json({ error: "rate" }, 429);
  const read = await readJson(request, MAX_BODY);
  if (!read.ok || typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) return json({ error: "invalid" }, 400);
  const raw = (read.value as Record<string, unknown>).name;
  const name = raw === undefined || raw === null ? "" : typeof raw === "string" ? raw.trim() : null;
  if (name === null || name.includes("\u0000") || [...name].length > MAX_NAME) return json({ error: "invalid_name" }, 400);
  try {
    const made = await createKey(appPool(), { userId: user.id, name: name || "Agent" });
    if (made.result === "no_user") return json({ error: "signed_out" }, 401);
    return json(made);
  } catch (error) {
    console.error(`[keys] create failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
