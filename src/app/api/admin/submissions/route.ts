import { json, notFound, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { decide } from "@/lib/app-store";
import { adminOrNull, appPool } from "@/lib/auth";
import { OWNER_KINDS, type OwnerKind } from "@/lib/handles";

export const dynamic = "force-dynamic";

const MAX_BODY = 2048;
const MAX_REASON = 280;

export async function POST(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await adminOrNull(request);
  if (!user) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);

  const read = await readJson(request, MAX_BODY);
  if (!read.ok || typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) {
    return json({ error: "invalid" }, 400);
  }
  const { handle, ownerKind, decision, reason } = read.value as Record<string, unknown>;
  if (typeof handle !== "string" || !/^[a-z0-9_]{1,15}$/.test(handle)) return json({ error: "invalid" }, 400);
  if (typeof ownerKind !== "string" || !(OWNER_KINDS as readonly string[]).includes(ownerKind)) return json({ error: "invalid" }, 400);
  if (decision !== "approve" && decision !== "reject") return json({ error: "invalid" }, 400);
  let why: string | null = null;
  if (decision === "reject") {
    const trimmed = typeof reason === "string" ? reason.trim() : "";
    if (trimmed === "" || [...trimmed].length > MAX_REASON || trimmed.includes("\u0000")) return json({ error: "invalid" }, 400);
    why = trimmed;
  }
  try {
    const changed = await decide(appPool(), {
      handle,
      ownerKind: ownerKind as OwnerKind,
      decision: decision === "approve" ? "approved" : "rejected",
      reason: why,
      adminId: user.id,
    });
    return json({ changed });
  } catch (error) {
    console.error(`[admin] decision failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
