import { Pool } from "pg";
import type { Language } from "./i18n";

export type EditorialArticle = {
  articleId: string;
  version: number;
  language: Language;
  title: string;
  summary: string;
  markdown: string;
  contentSha256: string;
  sourceCutoff: string;
  createdAt: string;
  status: "preview" | "approved";
};

export type PublicPreview = Pick<EditorialArticle,
  "articleId" | "version" | "language" | "title" | "summary" | "sourceCutoff" | "createdAt"
>;

export type ApprovedEditorialSummary = Pick<EditorialArticle,
  "articleId" | "version" | "language" | "title" | "summary" | "sourceCutoff" | "createdAt"
>;

export type EditorialPublicationPointers = { previewVersion: number | null; approvedVersion: number | null };

export type PublicEditorialAgentArticle = EditorialArticle & {
  revisionId: string;
  publicationStatus: "approved" | "preview" | "approved_historical";
  firstPublishedAt: string | null;
  approvedAt: string | null;
  currentApprovedRevisionId: string | null;
  currentPreviewRevisionId: string | null;
  supersededByRevisionId: string | null;
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pools = new Map<string, Pool>();

function databasePool(): Pool | null {
  const url = process.env.EDITORIAL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  const current = pools.get(url);
  if (current) return current;
  const pool = new Pool({
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    query_timeout: 10000,
    application_name: "surviagi-editorial-read",
  });
  pool.on("error", (error) => console.error(`[editorial] idle connection error: ${error.message}`));
  pools.set(url, pool);
  return pool;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

const revisionId = (articleId: string, version: number) => `article:${articleId}:v${version}`;

function publicAgentArticle(row: {
  article_id: string;
  version: number;
  language: Language;
  title: string;
  summary: string;
  body_markdown: string;
  content_sha256: string;
  source_cutoff: Date | string;
  created_at: Date | string;
  publication_status: "approved" | "preview" | "approved_historical";
  first_published_at: Date | string | null;
  approved_at: Date | string | null;
  current_approved_version: number | null;
  current_preview_version: number | null;
}): PublicEditorialAgentArticle {
  const currentApprovedRevisionId = row.current_approved_version === null ? null : revisionId(row.article_id, row.current_approved_version);
  const currentPreviewRevisionId = row.current_preview_version === null ? null : revisionId(row.article_id, row.current_preview_version);
  return {
    articleId: row.article_id,
    revisionId: revisionId(row.article_id, row.version),
    version: row.version,
    language: row.language,
    title: row.title,
    summary: row.summary,
    markdown: row.body_markdown,
    contentSha256: row.content_sha256,
    sourceCutoff: iso(row.source_cutoff),
    createdAt: iso(row.created_at),
    status: row.publication_status === "preview" ? "preview" : "approved",
    publicationStatus: row.publication_status,
    firstPublishedAt: nullableIso(row.first_published_at),
    approvedAt: nullableIso(row.approved_at),
    currentApprovedRevisionId,
    currentPreviewRevisionId,
    supersededByRevisionId: row.current_approved_version !== null && row.current_approved_version > row.version
      ? currentApprovedRevisionId
      : null,
  };
}

const AGENT_ARTICLE_SELECT = `SELECT a.article_id, v.version, l.language, l.title, l.summary, l.body_markdown,
       l.content_sha256, v.source_cutoff, v.created_at,
       CASE WHEN p.approved_version = v.version THEN 'approved'
            WHEN p.preview_version = v.version THEN 'preview'
            ELSE 'approved_historical' END AS publication_status,
       history.first_published_at, history.approved_at,
       p.approved_version AS current_approved_version,
       p.preview_version AS current_preview_version
  FROM editorial.articles a
  JOIN editorial.publications p USING (article_id)
  JOIN editorial.versions v ON v.article_id = p.article_id
  JOIN editorial.localizations l ON l.article_id = v.article_id AND l.version = v.version
  LEFT JOIN LATERAL (
    SELECT min(recorded_at) FILTER (WHERE action IN ('preview', 'approve')) AS first_published_at,
           min(recorded_at) FILTER (WHERE action = 'approve') AS approved_at
      FROM editorial.publication_history h
     WHERE h.article_id = a.article_id AND h.version = v.version
  ) history ON true`;

type AgentArticleRow = {
  article_id: string;
  version: number;
  language: Language;
  title: string;
  summary: string;
  body_markdown: string;
  content_sha256: string;
  source_cutoff: Date | string;
  created_at: Date | string;
  publication_status: "approved" | "preview" | "approved_historical";
  first_published_at: Date | string | null;
  approved_at: Date | string | null;
  current_approved_version: number | null;
  current_preview_version: number | null;
};

/** Public current pointers only; the database role cannot read the private app review schema. */
export async function publicEditorialAgentArticles(
  language: Language,
  status?: "approved" | "preview",
): Promise<PublicEditorialAgentArticle[] | null> {
  const db = databasePool();
  if (!db) return null;
  const query = `${AGENT_ARTICLE_SELECT}
    WHERE a.withdrawn_at IS NULL AND l.language = $1
      AND (p.approved_version = v.version OR p.preview_version = v.version)
      AND ($2::text IS NULL OR (p.approved_version = v.version AND $2 = 'approved')
                         OR (p.preview_version = v.version AND p.preview_version IS DISTINCT FROM p.approved_version AND $2 = 'preview'))
    ORDER BY v.created_at DESC, a.article_id, CASE WHEN p.approved_version = v.version THEN 0 ELSE 1 END`;
  const { rows } = await db.query<AgentArticleRow>(query, [language, status ?? null]);
  return rows.map(publicAgentArticle);
}

/** A searched revision or a previously approved revision still exposed by its versioned public route. */
export async function publicEditorialAgentArticle(
  articleId: string,
  version: number,
  language: Language,
): Promise<PublicEditorialAgentArticle | null> {
  if (!SLUG.test(articleId) || !Number.isSafeInteger(version) || version < 1) return null;
  const db = databasePool();
  if (!db) return null;
  const { rows } = await db.query<AgentArticleRow>(`${AGENT_ARTICLE_SELECT}
    WHERE a.article_id = $1 AND v.version = $2 AND a.withdrawn_at IS NULL AND l.language = $3
      AND (p.approved_version = v.version OR p.preview_version = v.version OR EXISTS (
        SELECT 1 FROM editorial.publication_history h
         WHERE h.article_id = a.article_id AND h.version = v.version AND h.action = 'approve'
      ))`, [articleId, version, language]);
  const row = rows[0];
  return row ? publicAgentArticle(row) : null;
}

/** Only the current public preview or approved version can be read by a public address. */
export async function publicEditorialArticle(
  articleId: string,
  version: number,
  language: Language,
): Promise<EditorialArticle | null> {
  if (!SLUG.test(articleId) || !Number.isSafeInteger(version) || version < 1) return null;
  const db = databasePool();
  if (!db) return null;
  const { rows } = await db.query<{
    article_id: string;
    version: number;
    language: Language;
    title: string;
    summary: string;
    body_markdown: string;
    content_sha256: string;
    source_cutoff: Date | string;
    created_at: Date | string;
    status: "preview" | "approved";
  }>(
    `SELECT a.article_id, v.version, l.language, l.title, l.summary, l.body_markdown,
            l.content_sha256, v.source_cutoff, v.created_at,
            CASE WHEN p.approved_version = v.version OR EXISTS (
              SELECT 1 FROM editorial.publication_history h
               WHERE h.article_id = p.article_id AND h.version = v.version AND h.action = 'approve'
            ) THEN 'approved' ELSE 'preview' END AS status
       FROM editorial.articles a
       JOIN editorial.publications p USING (article_id)
       JOIN editorial.versions v ON v.article_id = p.article_id
        AND v.version = $2
        AND (p.preview_version = v.version OR p.approved_version = v.version OR EXISTS (
          SELECT 1 FROM editorial.publication_history h
           WHERE h.article_id = p.article_id AND h.version = v.version AND h.action = 'approve'
        ))
       JOIN editorial.localizations l ON l.article_id = v.article_id AND l.version = v.version
      WHERE a.article_id = $1 AND a.withdrawn_at IS NULL AND l.language = $3`,
    [articleId, version, language],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    articleId: row.article_id,
    version: row.version,
    language: row.language,
    title: row.title,
    summary: row.summary,
    markdown: row.body_markdown,
    contentSha256: row.content_sha256,
    sourceCutoff: iso(row.source_cutoff),
    createdAt: iso(row.created_at),
    status: row.status,
  };
}

/** Current public previews only; approved-only articles stay out of this separate directory. */
export async function publicPreviews(language: Language): Promise<PublicPreview[]> {
  const db = databasePool();
  if (!db) return [];
  const { rows } = await db.query<{
    article_id: string;
    version: number;
    language: Language;
    title: string;
    summary: string;
    source_cutoff: Date | string;
    created_at: Date | string;
  }>(
    `SELECT a.article_id, v.version, l.language, l.title, l.summary, v.source_cutoff, v.created_at
       FROM editorial.articles a
       JOIN editorial.publications p USING (article_id)
       JOIN editorial.versions v ON v.article_id = p.article_id AND v.version = p.preview_version
       JOIN editorial.localizations l ON l.article_id = v.article_id AND l.version = v.version
      WHERE a.withdrawn_at IS NULL AND p.preview_version IS NOT NULL AND l.language = $1
      ORDER BY v.created_at DESC, a.article_id`,
    [language],
  );
  return rows.map((row) => ({
    articleId: row.article_id,
    version: row.version,
    language: row.language,
    title: row.title,
    summary: row.summary,
    sourceCutoff: iso(row.source_cutoff),
    createdAt: iso(row.created_at),
  }));
}

/** Only the current approved pointer belongs in the regular article index and feed. */
export async function approvedEditorialArticles(language: Language): Promise<ApprovedEditorialSummary[]> {
  const db = databasePool();
  if (!db) return [];
  const { rows } = await db.query<{
    article_id: string;
    version: number;
    language: Language;
    title: string;
    summary: string;
    source_cutoff: Date | string;
    created_at: Date | string;
  }>(
    `SELECT a.article_id, v.version, l.language, l.title, l.summary, v.source_cutoff, v.created_at
       FROM editorial.articles a
       JOIN editorial.publications p USING (article_id)
       JOIN editorial.versions v ON v.article_id = p.article_id AND v.version = p.approved_version
       JOIN editorial.localizations l ON l.article_id = v.article_id AND l.version = v.version
      WHERE a.withdrawn_at IS NULL AND p.approved_version IS NOT NULL AND l.language = $1
      ORDER BY v.created_at DESC, a.article_id`,
    [language],
  );
  return rows.map((row) => ({
    articleId: row.article_id,
    version: row.version,
    language: row.language,
    title: row.title,
    summary: row.summary,
    sourceCutoff: iso(row.source_cutoff),
    createdAt: iso(row.created_at),
  }));
}

/** Current public pointers for the administrator workflow; withdrawn articles have no public state to act on. */
export async function publicEditorialPointers(articleId: string): Promise<EditorialPublicationPointers | null> {
  if (!SLUG.test(articleId)) return null;
  const db = databasePool();
  if (!db) return null;
  const { rows } = await db.query<{ preview_version: number | null; approved_version: number | null }>(
    `SELECT p.preview_version, p.approved_version
       FROM editorial.publications p
       JOIN editorial.articles a USING (article_id)
      WHERE p.article_id = $1 AND a.withdrawn_at IS NULL`,
    [articleId],
  );
  const row = rows[0];
  return row ? { previewVersion: row.preview_version, approvedVersion: row.approved_version } : null;
}

/** Resolve the stable regular article address to the latest approved version only. */
export async function approvedEditorialArticle(articleId: string, language: Language): Promise<EditorialArticle | null> {
  if (!SLUG.test(articleId)) return null;
  const db = databasePool();
  if (!db) return null;
  const { rows } = await db.query<{
    article_id: string;
    version: number;
    language: Language;
    title: string;
    summary: string;
    body_markdown: string;
    content_sha256: string;
    source_cutoff: Date | string;
    created_at: Date | string;
  }>(
    `SELECT a.article_id, v.version, l.language, l.title, l.summary, l.body_markdown,
            l.content_sha256, v.source_cutoff, v.created_at
       FROM editorial.articles a
       JOIN editorial.publications p USING (article_id)
       JOIN editorial.versions v ON v.article_id = p.article_id AND v.version = p.approved_version
       JOIN editorial.localizations l ON l.article_id = v.article_id AND l.version = v.version
      WHERE a.article_id = $1 AND a.withdrawn_at IS NULL
        AND p.approved_version IS NOT NULL AND l.language = $2`,
    [articleId, language],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    articleId: row.article_id,
    version: row.version,
    language: row.language,
    title: row.title,
    summary: row.summary,
    markdown: row.body_markdown,
    contentSha256: row.content_sha256,
    sourceCutoff: iso(row.source_cutoff),
    createdAt: iso(row.created_at),
    status: "approved",
  };
}
