import { json, notFound, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { adminOrNull, appPool } from "@/lib/auth";

export const dynamic = "force-dynamic";

const ARTICLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableVersion(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) > 0);
}

/** Hide the complete article only after the exact current pointers and bilingual withdrawal reviews are confirmed. */
export async function POST(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await adminOrNull(request);
  if (!user) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);

  const read = await readJson(request, 4096);
  if (!read.ok || !isRecord(read.value)) return json({ error: "invalid" }, 400);
  const { articleId, expectedPreviewVersion, expectedApprovedVersion, reason } = read.value;
  if (typeof articleId !== "string" || !ARTICLE_ID.test(articleId)
      || !("expectedPreviewVersion" in read.value) || !nullableVersion(expectedPreviewVersion)
      || !("expectedApprovedVersion" in read.value) || !nullableVersion(expectedApprovedVersion)
      || typeof reason !== "string" || reason.includes("\u0000") || [...reason.trim()].length < 20 || [...reason.trim()].length > 1000) {
    return json({ error: "invalid" }, 400);
  }

  try {
    const result = await appPool().query<{ withdrawn: boolean }>(
      "SELECT editorial.withdraw_public_article($1, $2, $3, $4) AS withdrawn",
      [articleId, expectedPreviewVersion, expectedApprovedVersion, reason.trim()],
    );
    return json({ articleId, publicationChanged: result.rows[0]?.withdrawn === true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "P0002") return notFound();
    if (code === "40001") return json({ error: "stale_publication" }, 409);
    if (code === "P0001") return json({ error: "bilingual_withdrawal_required" }, 422);
    if (code === "22023") return json({ error: "invalid" }, 400);
    console.error(`[admin editorial] withdrawal failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
