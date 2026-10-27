import { terms } from "./agent-search";
import { publicEditorialAgentArticle, publicEditorialAgentArticles, type PublicEditorialAgentArticle } from "./editorial-store";
import type { Language } from "./i18n";
import { absoluteUrl } from "./seo";

export const EDITORIAL_STATUSES = ["approved", "preview"] as const;
export type EditorialStatusFilter = (typeof EDITORIAL_STATUSES)[number];

const ARTICLE_TYPE = "article" as const;
const MAX_SNIPPET = 280;
const clip = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return [...flat].length > MAX_SNIPPET ? `${[...flat].slice(0, MAX_SNIPPET - 1).join("")}…` : flat;
};
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

/** Links explicitly present in the public article body; private review data is never consulted. */
function sourceLinks(markdown: string): { url: string; label: string | null }[] {
  const links: { url: string; label: string | null }[] = [];
  const seen = new Set<string>();
  const markdownLinks = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of markdown.matchAll(markdownLinks)) {
    const url = match[2].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ url, label: match[1].trim() || null });
  }
  return links;
}

function reviewStatus(status: PublicEditorialAgentArticle["publicationStatus"]): string {
  if (status === "approved") return "approved_bilingual";
  if (status === "approved_historical") return "previously_approved";
  return "not_approved_public_preview";
}

function articleUrl(article: PublicEditorialAgentArticle): string {
  return article.publicationStatus === "approved"
    ? `/articles/approved/${article.articleId}`
    : `/articles/previews/${article.articleId}/v${article.version}`;
}

function dateBasis(article: PublicEditorialAgentArticle): "publication_history" | "version_created_at" {
  return article.firstPublishedAt ? "publication_history" : "version_created_at";
}

export type EditorialSearchResult = {
  id: string;
  type: typeof ARTICLE_TYPE;
  title: string;
  snippet: string;
  content: "editorial_article";
  review: string;
  status: PublicEditorialAgentArticle["publicationStatus"];
  revision_id: string;
  version: number;
  language: Language;
  date: string | null;
  substantive_modified_at: string;
  first_published_at: string | null;
  date_basis: "publication_history" | "version_created_at";
  approved_at: string | null;
  evidence_cutoff: string;
  url: string;
  markdown_url: string;
  alternate_language_url: string;
  alternate_markdown_url: string;
  sources: string[];
  approval_scope: { required_languages: Language[]; approved_languages: Language[] | null };
  current_pointers: { approved_revision_id: string | null; preview_revision_id: string | null };
  superseded_by_revision_id: string | null;
};

export type RankedEditorialResult = { result: EditorialSearchResult; score: number };

/** Search both current public pointers for one language. No app-schema query or private review text is used. */
export async function searchEditorialArticles(input: {
  query: string;
  limit: number;
  language: Language;
  from: string | null;
  to: string | null;
  status?: EditorialStatusFilter;
}): Promise<{ available: boolean; total: number; results: RankedEditorialResult[] }> {
  const articles = await publicEditorialAgentArticles(input.language, input.status);
  if (articles === null) return { available: false, total: 0, results: [] };
  const words = terms(input.query);
  const phrase = normalize(input.query).trim();
  const need = words.length <= 2 ? words.length : Math.ceil(words.length / 2);
  if (words.length === 0) return { available: true, total: 0, results: [] };

  const results: RankedEditorialResult[] = [];
  for (const article of articles) {
    const date = article.firstPublishedAt ?? article.createdAt;
    const day = date.slice(0, 10);
    if (input.from && day < input.from) continue;
    if (input.to && day > input.to) continue;
    const fields = [
      { text: normalize(article.title), weight: 5 },
      { text: normalize(article.summary), weight: 3 },
      { text: normalize(article.markdown), weight: 1 },
    ];
    let matched = 0;
    let score = 0;
    for (const word of words) {
      let best = 0;
      for (const field of fields) if (field.weight > best && field.text.includes(word)) best = field.weight;
      if (best > 0) {
        matched += 1;
        score += best;
      }
    }
    if (matched < need) continue;
    if (phrase.length > 2 && fields.some((field) => field.text.includes(phrase))) score += 5;
    if (article.publicationStatus === "approved") score += 0.25;
    const path = articleUrl(article);
    const alternate = path;
    results.push({
      score: score + matched / Math.max(1, words.length),
      result: {
        id: article.revisionId,
        type: ARTICLE_TYPE,
        title: article.title,
        snippet: clip(article.summary),
        content: "editorial_article",
        review: reviewStatus(article.publicationStatus),
        status: article.publicationStatus,
        revision_id: article.revisionId,
        version: article.version,
        language: input.language,
        date: article.firstPublishedAt ?? article.createdAt,
        substantive_modified_at: article.createdAt,
        first_published_at: article.firstPublishedAt,
        date_basis: dateBasis(article),
        approved_at: article.approvedAt,
        evidence_cutoff: article.sourceCutoff,
        url: absoluteUrl(input.language, path),
        markdown_url: absoluteUrl(input.language, `${path}/raw.md`),
        alternate_language_url: absoluteUrl(input.language === "en" ? "zh-CN" : "en", alternate),
        alternate_markdown_url: absoluteUrl(input.language === "en" ? "zh-CN" : "en", `${alternate}/raw.md`),
        sources: sourceLinks(article.markdown).map((source) => source.url),
        approval_scope: {
          required_languages: ["en", "zh-CN"],
          approved_languages: article.publicationStatus === "approved" ? ["en", "zh-CN"] : null,
        },
        current_pointers: {
          approved_revision_id: article.currentApprovedRevisionId,
          preview_revision_id: article.currentPreviewRevisionId,
        },
        superseded_by_revision_id: article.supersededByRevisionId,
      },
    });
  }
  results.sort((a, b) => b.score - a.score ||
    Number(b.result.status === "approved") - Number(a.result.status === "approved") ||
    b.result.substantive_modified_at.localeCompare(a.result.substantive_modified_at) ||
    a.result.id.localeCompare(b.result.id));
  return { available: true, total: results.length, results: results.slice(0, input.limit) };
}

export async function getEditorialArticleRecord(articleId: string, version: number, language: Language) {
  const article = await publicEditorialAgentArticle(articleId, version, language);
  if (!article) return null;
  const path = articleUrl(article);
  const alternate = path;
  return {
    id: article.revisionId,
    type: ARTICLE_TYPE,
    status: article.publicationStatus,
    review: reviewStatus(article.publicationStatus),
    revision_id: article.revisionId,
    version: article.version,
    language,
    title: article.title,
    summary: article.summary,
    content: "editorial_article" as const,
    body_markdown: article.markdown,
    content_sha256: article.contentSha256,
    url: absoluteUrl(language, path),
    markdown_url: absoluteUrl(language, `${path}/raw.md`),
    alternate_language_url: absoluteUrl(language === "en" ? "zh-CN" : "en", alternate),
    alternate_markdown_url: absoluteUrl(language === "en" ? "zh-CN" : "en", `${alternate}/raw.md`),
    sources: sourceLinks(article.markdown),
    evidence_cutoff: article.sourceCutoff,
    substantive_modified_at: article.createdAt,
    first_published_at: article.firstPublishedAt,
    date_basis: dateBasis(article),
    approved_at: article.approvedAt,
    approval_scope: {
      required_languages: ["en", "zh-CN"] as Language[],
      approved_languages: article.publicationStatus === "approved" || article.publicationStatus === "approved_historical"
        ? ["en", "zh-CN"] as Language[]
        : null,
    },
    current_pointers: {
      approved_revision_id: article.currentApprovedRevisionId,
      preview_revision_id: article.currentPreviewRevisionId,
    },
    superseded_by_revision_id: article.supersededByRevisionId,
    structured_limitations: {
      available: false,
      note: "Limitations are not stored in a separate public field. Read the complete article and evidence cutoff; absence of structured limitations does not mean there are none.",
    },
  };
}

export function parseEditorialRevisionId(id: string): { articleId: string; version: number } | null {
  const match = /^article:([a-z0-9]+(?:-[a-z0-9]+)*):v([1-9][0-9]*)$/.exec(id);
  if (!match) return null;
  const version = Number(match[2]);
  return Number.isSafeInteger(version) ? { articleId: match[1], version } : null;
}
