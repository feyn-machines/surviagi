import { articles } from "@/lib/articles";
import { LANGUAGES, normalizeLanguage, DEFAULT_LANGUAGE } from "@/lib/i18n";
import { SITE_NAME, absoluteUrl } from "@/lib/seo";

/** The articles of one language as an RSS feed, built with the pages. */
export const dynamic = "force-static";

export function generateStaticParams() {
  return LANGUAGES.map((lang) => ({ lang }));
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET(_: Request, { params }: { params: Promise<{ lang: string }> }) {
  const language = normalizeLanguage((await params).lang) ?? DEFAULT_LANGUAGE;
  const items = articles(language).filter((item) => !item.draft);
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${escape(SITE_NAME)}</title>`,
    `<link>${absoluteUrl(language, "/articles")}</link>`,
    `<description>${escape(SITE_NAME)}</description>`,
    `<language>${language}</language>`,
    ...items.map((item) => {
      const url = absoluteUrl(language, `/articles/${item.slug}`);
      return `<item><title>${escape(item.title)}</title><link>${url}</link><guid>${url}</guid>` +
        `<pubDate>${new Date(`${item.date}T00:00:00Z`).toUTCString()}</pubDate>` +
        `<description>${escape(item.description)}</description></item>`;
    }),
    "</channel></rss>",
  ].join("\n");
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
