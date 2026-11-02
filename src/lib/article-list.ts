import publishedArticles from "@/content/articles.json";
import { approvedEditorialArticles } from "@/lib/editorial-store";
import type { Language } from "@/lib/i18n";

export type ListedArticle = {
  slug: string;
  title: string;
  description: string;
  date: string;
  /** Path without a language prefix. */
  path: string;
  approved: boolean;
};

/** Static Markdown articles plus the editorially approved ones, newest first; an approved version replaces a static one with the same slug. */
export async function listedArticles(language: Language): Promise<ListedArticle[]> {
  const approved = await approvedEditorialArticles(language);
  const approvedSlugs = new Set(approved.map((item) => item.articleId));
  return [
    ...publishedArticles.filter((item) => !approvedSlugs.has(item.slug)).map((item) => ({
      path: `/articles/${item.slug}`,
      approved: false,
      slug: item.slug,
      title: item.title[language],
      description: item.description[language],
      date: item.date,
    })),
    ...approved.map((item) => ({
      slug: item.articleId,
      title: item.title,
      description: item.summary,
      date: item.createdAt.slice(0, 10),
      path: `/articles/approved/${item.articleId}`,
      approved: true,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}
