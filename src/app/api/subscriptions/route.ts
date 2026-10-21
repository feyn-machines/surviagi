import { json, notFound, rateLimit, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { setSubscriptions } from "@/lib/app-store";
import { appPool, currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const MAX_BODY = 1024;

export async function PUT(request: Request) {
  if (!appEnabled()) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);
  const user = await currentUser(request);
  if (!user) return json({ error: "signed_out" }, 401);
  if (!rateLimit(`subscribe:${user.id}`, 60, 3600_000)) return json({ error: "rate" }, 429);

  const read = await readJson(request, MAX_BODY);
  if (!read.ok || typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) {
    return json({ error: "invalid" }, 400);
  }
  const { updates, weekly, language } = read.value as Record<string, unknown>;
  if (typeof updates !== "boolean" || typeof weekly !== "boolean" || (language !== "en" && language !== "zh-CN")) {
    return json({ error: "invalid" }, 400);
  }
  try {
    const saved = await setSubscriptions(appPool(), { userId: user.id, language, updates, weekly });
    return saved ? json({ subscriptions: saved }) : json({ error: "signed_out" }, 401);
  } catch (error) {
    console.error(`[subscriptions] save failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
