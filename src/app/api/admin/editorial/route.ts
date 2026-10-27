import { json, notFound, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { adminOrNull, appPool } from "@/lib/auth";
import { publicEditorialArticle, publicEditorialPointers } from "@/lib/editorial-store";
import type { Language } from "@/lib/i18n";

export const dynamic = "force-dynamic";

const ARTICLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;
const LANGUAGES = ["en", "zh-CN"] as const;
const SCOPES = ["readability", "language_quality", "factual_accuracy", "source_quality", "publication"] as const;
const DECISIONS = ["comment", "request_revision", "hold", "approve", "withdraw"] as const;
const MAX_BODY = 192 * 1024;
const MAX_MARKDOWN = 96 * 1024;
const MAX_NOTE = 4000;
const MAX_ANNOTATIONS = 25;

type AnnotationInput = {
  paragraphKey: string;
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
  comment: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.includes("\u0000")) return null;
  const trimmed = value.trim();
  if ((!allowEmpty && !trimmed) || [...trimmed].length > max) return null;
  return trimmed;
}

function rawText(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.includes("\u0000") || value.length > max) return null;
  if (!allowEmpty && !value.trim()) return null;
  return value;
}

function articleMarkdown(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\u0000") || !value.trim() || value.length > MAX_MARKDOWN) return null;
  return value;
}

function parseAnnotation(value: unknown): AnnotationInput | null {
  if (!isRecord(value)) return null;
  const paragraphKey = cleanText(value.paragraphKey, 160);
  const selectedText = rawText(value.selectedText, 3000, true);
  const contextBefore = rawText(value.contextBefore ?? "", 600, true);
  const contextAfter = rawText(value.contextAfter ?? "", 600, true);
  const comment = cleanText(value.comment, 3000);
  if (paragraphKey === null || selectedText === null || contextBefore === null || contextAfter === null || comment === null) return null;
  return { paragraphKey, selectedText, contextBefore, contextAfter, comment };
}

function fullReplacementDiff(before: string, after: string, version: number): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  return [
    `--- article-v${version}`,
    `+++ review-v${version}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function target(request: Request): { articleId: string; version: number; language: Language } | null {
  const params = new URL(request.url).searchParams;
  const articleId = params.get("articleId") ?? "";
  const versionText = params.get("version") ?? "";
  const language = params.get("language");
  if (!ARTICLE_ID.test(articleId) || !/^[1-9][0-9]{0,8}$/.test(versionText) || !(LANGUAGES as readonly string[]).includes(language ?? "")) return null;
  return { articleId, version: Number(versionText), language: language as Language };
}

/** Read one currently public article version and its private review history. */
export async function GET(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await adminOrNull(request);
  if (!user) return notFound();
  const selected = target(request);
  if (!selected) return json({ error: "invalid" }, 400);

  try {
    const article = await publicEditorialArticle(selected.articleId, selected.version, selected.language);
    if (!article) return notFound();
    const currentPointers = await publicEditorialPointers(selected.articleId);
    if (!currentPointers) return notFound();
    const db = appPool();
    const reviews = await db.query<{
      review_id: string;
      content_sha256: string;
      review_scope: string;
      decision: string;
      actor_kind: string;
      actor_id: string;
      note: string;
      created_at: Date;
    }>(
      `SELECT review_id, content_sha256, review_scope, decision, actor_kind, actor_id, note, created_at
         FROM app.editorial_reviews
        WHERE article_id = $1 AND version = $2 AND language = $3
        ORDER BY created_at, review_id`,
      [article.articleId, article.version, article.language],
    );
    const ids = reviews.rows.map((row) => row.review_id);
    const [annotations, edits] = ids.length
      ? await Promise.all([
          db.query(
            `SELECT annotation_id, review_id, paragraph_key, selected_text, context_before, context_after, comment, created_at
               FROM app.editorial_review_annotations WHERE review_id = ANY($1::bigint[]) ORDER BY annotation_id`,
            [ids],
          ),
          db.query(
            `SELECT edit_id, review_id, before_markdown, after_markdown, unified_diff, created_at
               FROM app.editorial_review_edits WHERE review_id = ANY($1::bigint[]) ORDER BY edit_id`,
            [ids],
          ),
        ])
      : [{ rows: [] }, { rows: [] }];
    return json({ article, currentPointers, reviews: reviews.rows, annotations: annotations.rows, edits: edits.rows });
  } catch (error) {
    console.error(`[admin editorial] read failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}

/** Append a review event, annotations and/or a suggested edit for the exact current text hash. */
export async function POST(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await adminOrNull(request);
  if (!user) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);

  const read = await readJson(request, MAX_BODY);
  if (!read.ok || !isRecord(read.value)) return json({ error: "invalid" }, 400);
  const body = read.value;
  const { articleId, version, language, contentSha256, reviewScope, decision } = body;
  if (typeof articleId !== "string" || !ARTICLE_ID.test(articleId)) return json({ error: "invalid" }, 400);
  if (!Number.isSafeInteger(version) || (version as number) < 1) return json({ error: "invalid" }, 400);
  if (typeof language !== "string" || !(LANGUAGES as readonly string[]).includes(language)) return json({ error: "invalid" }, 400);
  if (typeof contentSha256 !== "string" || !HASH.test(contentSha256)) return json({ error: "invalid" }, 400);
  if (typeof reviewScope !== "string" || !(SCOPES as readonly string[]).includes(reviewScope)) return json({ error: "invalid" }, 400);
  if (typeof decision !== "string" || !(DECISIONS as readonly string[]).includes(decision)) return json({ error: "invalid" }, 400);
  const note = cleanText(body.note, MAX_NOTE);
  if (note === null) return json({ error: "invalid" }, 400);

  let annotations: AnnotationInput[] = [];
  if (body.annotations !== undefined) {
    if (!Array.isArray(body.annotations) || body.annotations.length > MAX_ANNOTATIONS) return json({ error: "invalid" }, 400);
    const parsed = body.annotations.map(parseAnnotation);
    if (parsed.some((item) => item === null)) return json({ error: "invalid" }, 400);
    annotations = parsed as AnnotationInput[];
  }

  let afterMarkdown: string | null = null;
  if (body.edit !== undefined) {
    if (!isRecord(body.edit)) return json({ error: "invalid" }, 400);
    afterMarkdown = articleMarkdown(body.edit.afterMarkdown);
    if (afterMarkdown === null) return json({ error: "invalid" }, 400);
  }

  try {
    const article = await publicEditorialArticle(articleId, version as number, language as Language);
    if (!article) return notFound();
    if (article.contentSha256 !== contentSha256) return json({ error: "stale_version" }, 409);

    const db = appPool();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Serialize new review decisions with the approval transaction for this article version.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`editorial-review:${article.articleId}:v${article.version}`],
      );
      const stillPublic = await publicEditorialArticle(article.articleId, article.version, article.language);
      if (!stillPublic || stillPublic.contentSha256 !== article.contentSha256) {
        await client.query("ROLLBACK");
        return json({ error: "stale_version" }, 409);
      }
      const review = await client.query<{ review_id: string }>(
        `INSERT INTO app.editorial_reviews
          (article_id, version, language, content_sha256, review_scope, decision, actor_kind, actor_id, note)
         VALUES ($1, $2, $3, $4, $5, $6, 'human', $7, $8)
         RETURNING review_id`,
        [article.articleId, article.version, article.language, article.contentSha256, reviewScope, decision, user.id, note],
      );
      const reviewId = review.rows[0].review_id;
      for (const annotation of annotations) {
        await client.query(
          `INSERT INTO app.editorial_review_annotations
            (review_id, paragraph_key, selected_text, context_before, context_after, comment)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [reviewId, annotation.paragraphKey, annotation.selectedText, annotation.contextBefore, annotation.contextAfter, annotation.comment],
        );
      }
      if (afterMarkdown !== null && afterMarkdown !== article.markdown) {
        await client.query(
          `INSERT INTO app.editorial_review_edits (review_id, before_markdown, after_markdown, unified_diff)
           VALUES ($1, $2, $3, $4)`,
          [reviewId, article.markdown, afterMarkdown, fullReplacementDiff(article.markdown, afterMarkdown, article.version)],
        );
      }
      await client.query("COMMIT");
      return json({ reviewId, publicationChanged: false });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`[admin editorial] write failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
