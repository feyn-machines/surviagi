import { json, notFound, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { adminOrNull, appPool } from "@/lib/auth";

export const dynamic = "force-dynamic";

const ARTICLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Move the approved pointer only when the exact current preview has a current human approval in each language. */
export async function POST(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await adminOrNull(request);
  if (!user) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);

  const read = await readJson(request, 4096);
  if (!read.ok || !isRecord(read.value)) return json({ error: "invalid" }, 400);
  const { articleId, version, contentSha256 } = read.value;
  if (typeof articleId !== "string" || !ARTICLE_ID.test(articleId)) return json({ error: "invalid" }, 400);
  if (!Number.isSafeInteger(version) || (version as number) < 1) return json({ error: "invalid" }, 400);
  if (!isRecord(contentSha256) || typeof contentSha256.en !== "string" || !HASH.test(contentSha256.en)
      || typeof contentSha256["zh-CN"] !== "string" || !HASH.test(contentSha256["zh-CN"])) {
    return json({ error: "invalid" }, 400);
  }

  try {
    const result = await appPool().query<{ changed: boolean }>(
      "SELECT editorial.approve_public_preview($1, $2, $3, $4) AS changed",
      [articleId, version, contentSha256.en, contentSha256["zh-CN"]],
    );
    return json({ articleId, version, publicationChanged: result.rows[0]?.changed === true });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    if (code === "P0002") return notFound();
    if (code === "40001") return json({ error: "stale_preview" }, 409);
    if (code === "P0001") return json({ error: "bilingual_approval_required" }, 422);
    console.error(`[admin editorial] approval failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
