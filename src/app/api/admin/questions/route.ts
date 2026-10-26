import { json, notFound, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { decideQuestion } from "@/lib/app-store";
import { adminOrNull, appPool } from "@/lib/auth";

export const dynamic = "force-dynamic";

const MAX_REASON = 280;

/** An administrator accepts a submitted question for research, or rejects it with a reason. */
export async function POST(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await adminOrNull(request);
  if (!user) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);

  const read = await readJson(request, 2048);
  if (!read.ok || typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) return json({ error: "invalid" }, 400);
  const { id, decision, reason } = read.value as Record<string, unknown>;
  if (typeof id !== "string" || !/^[1-9][0-9]{0,17}$/.test(id)) return json({ error: "invalid" }, 400);
  if (decision !== "accept" && decision !== "reject") return json({ error: "invalid" }, 400);
  let why: string | null = null;
  if (decision === "reject") {
    const trimmed = typeof reason === "string" ? reason.trim() : "";
    if (trimmed === "" || [...trimmed].length > MAX_REASON || trimmed.includes("\u0000")) return json({ error: "invalid" }, 400);
    why = trimmed;
  }
  try {
    const changed = await decideQuestion(appPool(), { id, decision: decision === "accept" ? "accepted" : "rejected", reason: why, adminId: user.id });
    return json({ changed });
  } catch (error) {
    console.error(`[admin] question decision failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
