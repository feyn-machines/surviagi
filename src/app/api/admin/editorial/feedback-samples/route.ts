import { json, notFound, readJson, sameOrigin } from "@/lib/api";
import { appEnabled } from "@/lib/app-config";
import { adminOrNull, appPool } from "@/lib/auth";

export const dynamic = "force-dynamic";

const LANGUAGES = ["en", "zh-CN"] as const;
const SCOPES = ["single_article", "reusable_preference"] as const;
const ISSUE_TYPES = ["evidence_boundary", "structure", "clarity", "specificity", "tone", "redundancy", "headline", "natural_language", "other"] as const;
const GENRES = ["event_thread", "product_comparison", "capability_explainer", "workflow", "other"] as const;
const ARTICLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bigintText(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return false;
  return value.length < 19 || value <= "9223372036854775807";
}

function text(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && !value.includes("\u0000") && [...value.trim()].length >= min && [...value].length <= max;
}

/** Curate a private example from a specific human edit; no review history is exposed publicly. */
export async function POST(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await adminOrNull(request);
  if (!user) return notFound();
  if (!sameOrigin(request)) return json({ error: "origin" }, 403);

  const read = await readJson(request, 8192);
  if (!read.ok || !isRecord(read.value)) return json({ error: "invalid" }, 400);
  const body = read.value;
  if (!bigintText(body.sourceReviewId) || !bigintText(body.sourceEditId)
      || typeof body.language !== "string" || !(LANGUAGES as readonly string[]).includes(body.language)
      || typeof body.feedbackScope !== "string" || !(SCOPES as readonly string[]).includes(body.feedbackScope)
      || typeof body.issueType !== "string" || !(ISSUE_TYPES as readonly string[]).includes(body.issueType)
      || typeof body.articleGenre !== "string" || !(GENRES as readonly string[]).includes(body.articleGenre)
      || !text(body.problem, 10, 1200) || !text(body.beforeExcerpt, 1, 3000)
      || !text(body.afterExcerpt, 1, 3000) || !text(body.applicability, 10, 1200)) return json({ error: "invalid" }, 400);

  let preferenceEvidence: string | null;
  if (body.feedbackScope === "reusable_preference") {
    if (!text(body.preferenceEvidence, 10, 1200)) return json({ error: "invalid" }, 400);
    preferenceEvidence = body.preferenceEvidence.trim();
  } else {
    if (body.preferenceEvidence !== null) return json({ error: "invalid" }, 400);
    preferenceEvidence = null;
  }

  try {
    const result = await appPool().query<{ sample_id: string }>(
      `INSERT INTO app.editorial_feedback_samples
        (source_review_id, source_edit_id, feedback_scope, issue_type, article_genre, problem, before_excerpt, after_excerpt, applicability, preference_evidence, curator_id)
       SELECT r.review_id, e.edit_id, $3, $4, $5, $6, $7, $8, $9, $10, $11
         FROM app.editorial_reviews r
         JOIN app.editorial_review_edits e ON e.review_id = r.review_id
        WHERE r.review_id = $1::bigint AND e.edit_id = $2::bigint AND r.language = $12 AND r.actor_kind = 'human'
       RETURNING sample_id::text`,
      [body.sourceReviewId, body.sourceEditId, body.feedbackScope, body.issueType, body.articleGenre,
        body.problem.trim(), body.beforeExcerpt.trim(), body.afterExcerpt.trim(), body.applicability.trim(),
        preferenceEvidence, user.id, body.language],
    );
    if (!result.rowCount) return json({ error: "source_unavailable" }, 404);
    return json({ sampleId: result.rows[0].sample_id }, 201);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "23505") return json({ error: "duplicate_sample" }, 409);
    if (code === "P0001" || code === "23514") return json({ error: "invalid_sample" }, 400);
    console.error(`[admin editorial] feedback sample curation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}

/** Return at most three curated examples for this language and context, never a dump of review conversations. */
export async function GET(request: Request) {
  if (!appEnabled()) return notFound();
  const user = await adminOrNull(request);
  if (!user) return notFound();
  const params = new URL(request.url).searchParams;
  const language = params.get("language");
  const issueType = params.get("issueType");
  const articleGenre = params.get("articleGenre");
  const articleId = params.get("articleId");
  if (!(LANGUAGES as readonly string[]).includes(language ?? "")
      || (issueType && !(ISSUE_TYPES as readonly string[]).includes(issueType))
      || (articleGenre && !(GENRES as readonly string[]).includes(articleGenre))
      || (articleId && !ARTICLE_ID.test(articleId))) return json({ error: "invalid" }, 400);

  try {
    const result = await appPool().query<{
      sample_id: string; feedback_scope: string; issue_type: string; article_genre: string; problem: string;
      before_excerpt: string; after_excerpt: string; applicability: string; preference_evidence: string | null; source_article_id: string; source_version: number;
      source_language: string; source_content_sha256: string; source_review_id: string; source_edit_id: string;
      created_at: Date;
    }>(
      `SELECT s.sample_id::text, s.feedback_scope, s.issue_type, s.article_genre, s.problem, s.before_excerpt,
              s.after_excerpt, s.applicability,
              s.preference_evidence, r.article_id AS source_article_id, r.version AS source_version,
              r.language AS source_language, r.content_sha256 AS source_content_sha256,
              r.review_id::text AS source_review_id, e.edit_id::text AS source_edit_id, s.created_at
         FROM app.editorial_feedback_samples s
         JOIN app.editorial_reviews r ON r.review_id = s.source_review_id
         JOIN app.editorial_review_edits e ON e.edit_id = s.source_edit_id AND e.review_id = r.review_id
        WHERE r.language = $1
          AND ($2::text IS NULL OR s.issue_type = $2)
          AND ($3::text IS NULL OR s.article_genre = $3)
          AND (s.feedback_scope = 'reusable_preference' OR ($4::text IS NOT NULL AND r.article_id = $4))
        ORDER BY (s.issue_type = $2) DESC NULLS LAST,
                 (s.article_genre = $3) DESC NULLS LAST,
                 (s.feedback_scope = 'reusable_preference') DESC,
                 s.created_at DESC, s.sample_id DESC
        LIMIT 3`,
      [language, issueType, articleGenre, articleId],
    );
    return json({ samples: result.rows });
  } catch (error) {
    console.error(`[admin editorial] feedback sample retrieval failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return json({ error: "unavailable" }, 503);
  }
}
