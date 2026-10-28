import { json, notFound, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { adminOrNull, appPool } from "@/lib/auth";
import { parseApprovalBatch } from "@/lib/editorial-batch";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

/** Approve explicit article versions independently; each result is isolated from the rest of the batch. */
export async function POST(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await adminOrNull(request);
  if (!user) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);

  const read = await readJson(request, 64 * 1024);
  if (!read.ok) return json({ error: "invalid" }, 400);
  const batch = parseApprovalBatch(read.value);
  if (!batch) return json({ error: "invalid" }, 400);

  const db = appPool();
  const requestHash = createHash("sha256").update(JSON.stringify(batch.items)).digest("hex");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`editorial-approval-batch:${batch.batchId}`]);
    const existing = await client.query<{ actor_id: string; request_sha256: string }>(
      "SELECT actor_id, request_sha256 FROM app.editorial_approval_batches WHERE batch_id = $1", [batch.batchId],
    );
    if (existing.rows.length) {
      if (existing.rows[0].actor_id !== user.id || existing.rows[0].request_sha256 !== requestHash) {
        await client.query("ROLLBACK");
        return json({ error: "batch_id_reused" }, 409);
      }
      const prior = await client.query(
        `SELECT article_id AS "articleId", version,
                jsonb_build_object('en', en_sha256, 'zh-CN', zh_sha256) AS "contentSha256",
                result AS status, publication_changed AS "publicationChanged"
           FROM app.editorial_approval_batch_items WHERE batch_id = $1 ORDER BY item_index`,
        [batch.batchId],
      );
      await client.query("COMMIT");
      return json({ batchId: batch.batchId, requestedBy: user.id, results: prior.rows, replayed: true });
    }
    await client.query(
      "INSERT INTO app.editorial_approval_batches(batch_id, actor_id, request_sha256) VALUES ($1, $2, $3)",
      [batch.batchId, user.id, requestHash],
    );
    const results = [];
    for (const [itemIndex, item] of batch.items.entries()) {
      let status = "approved";
      let publicationChanged = false;
      await client.query("SAVEPOINT editorial_approval_item");
      try {
      const result = await client.query<{ changed: boolean }>(
          "SELECT editorial.approve_public_preview($1, $2, $3, $4) AS changed",
          [item.articleId, item.version, item.contentSha256.en, item.contentSha256["zh-CN"]],
        );
        publicationChanged = result.rows[0]?.changed === true;
      if (!publicationChanged) status = "already_approved";
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT editorial_approval_item");
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        status = code === "40001" ? "conflict"
          : code === "P0001" ? "needs_bilingual_approval"
            : code === "P0002" ? "not_found" : "unavailable";
      }
      await client.query("RELEASE SAVEPOINT editorial_approval_item");
      await client.query(
        `INSERT INTO app.editorial_approval_batch_items
          (batch_id, item_index, article_id, version, en_sha256, zh_sha256, result, publication_changed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [batch.batchId, itemIndex, item.articleId, item.version, item.contentSha256.en, item.contentSha256["zh-CN"], status, publicationChanged],
      );
      results.push({ articleId: item.articleId, version: item.version, contentSha256: item.contentSha256, status, publicationChanged });
    }
    await client.query("COMMIT");
    return json({ batchId: batch.batchId, requestedBy: user.id, results, replayed: false });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`[admin editorial] batch approval failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  } finally {
    client.release();
  }
}
