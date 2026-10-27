import publishedArticles from "@/content/articles.json";
import { LANGUAGES, normalizeLanguage, DEFAULT_LANGUAGE } from "@/lib/i18n";
import { SITE_NAME, absoluteUrl } from "@/lib/seo";
import { approvedEditorialArticles } from "@/lib/editorial-store";

/** Regular RSS includes static articles and only the current approved editorial version. */
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return LANGUAGES.map((lang) => ({ lang }));
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET(_: Request, { params }: { params: Promise<{ lang: string }> }) {
  const language = normalizeLanguage((await params).lang) ?? DEFAULT_LANGUAGE;
  const approved = await approvedEditorialArticles(language);
  const approvedSlugs = new Set(approved.map((item) => item.articleId));
  const items = [
    ...publishedArticles.filter((item) => !approvedSlugs.has(item.slug)).map((item) => ({
      slug: item.slug,
      path: `/articles/${item.slug}`,
      title: item.title[language],
      description: item.description[language],
      date: item.date,
    })),
    ...approved.map((item) => ({
      slug: item.articleId,
      path: `/articles/approved/${item.articleId}`,
      title: item.title,
      description: item.summary,
      date: item.createdAt.slice(0, 10),
    })),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${escape(SITE_NAME)}</title>`,
    `<link>${absoluteUrl(language, "/articles")}</link>`,
    `<description>${escape(SITE_NAME)}</description>`,
    `<language>${language}</language>`,
    ...items.map((item) => {
      const url = absoluteUrl(language, item.path);
      return `<item><title>${escape(item.title)}</title><link>${url}</link><guid>${url}</guid>` +
        `<pubDate>${new Date(`${item.date}T00:00:00Z`).toUTCString()}</pubDate>` +
        `<description>${escape(item.description)}</description></item>`;
    }),
    "</channel></rss>",
  ].join("\n");
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
