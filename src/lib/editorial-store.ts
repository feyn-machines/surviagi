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

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const pools = new Map<string, Pool>();

function databasePool(): Pool | null {
  const url = process.env.DATABASE_URL;
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
            CASE WHEN p.approved_version = v.version THEN 'approved' ELSE 'preview' END AS status
       FROM editorial.articles a
       JOIN editorial.publications p USING (article_id)
       JOIN editorial.versions v ON v.article_id = p.article_id
        AND v.version = $2
        AND (p.preview_version = v.version OR p.approved_version = v.version)
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
