import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/data-page";
import d from "@/components/data-page.module.css";
import { approvedEditorialArticles } from "@/lib/editorial-store";
import publishedArticles from "@/content/articles.json";
import { bilingual, localizedPath } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { absoluteUrl, pageMetadata } from "@/lib/seo";
import type { Route } from "next";
import s from "./articles.module.css";

/** Static Markdown remains available as a fallback; approved editorial pointers are read live. */
export const dynamic = "force-dynamic";

const copy = bilingual({
  en: {
    metaTitle: "Articles",
    metaDescription: "What changed in AI doing real work, read from the updates and from what people report doing with them.",
    eyebrow: "ARTICLES",
    title: "Articles",
    empty: "No articles yet.",
    draft: "DRAFT",
    approved: "APPROVED",
  },
  "zh-CN": {
    metaTitle: "文章",
    metaDescription: "AI 在真实工作上发生了什么变化，取自各家的更新和人们自述用它做了什么。",
    eyebrow: "文章",
    title: "文章",
    empty: "暂无文章。",
    draft: "草稿",
    approved: "已批准",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  const c = copy[language];
  const metadata = pageMetadata({ language, path: "/articles", title: c.metaTitle, description: c.metaDescription });
  return {
    ...metadata,
    alternates: { ...metadata.alternates, types: { "application/rss+xml": absoluteUrl(language, "/articles/feed.xml") } },
  };
}

export default async function Articles() {
  const { language } = await getLocale();
  const c = copy[language];
  const approved = await approvedEditorialArticles(language);
  const approvedSlugs = new Set(approved.map((item) => item.articleId));
  const list = [
    ...publishedArticles.filter((item) => !approvedSlugs.has(item.slug)).map((item) => ({
      path: `/articles/${item.slug}`,
      approved: false,
      slug: item.slug,
      title: item.title[language],
      description: item.description[language],
      date: item.date,
      draft: false,
    })),
    ...approved.map((item) => ({
      slug: item.articleId,
      title: item.title,
      description: item.summary,
      date: item.createdAt.slice(0, 10),
      draft: false,
      path: `/articles/approved/${item.articleId}`,
      approved: true,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  return (
    <div className={d.page}>
      <PageHeader eyebrow={c.eyebrow} title={c.title} />
      {list.length === 0 ? <p className={d.note}>{c.empty}</p> : null}
      <ul className={s.list}>
        {list.map((item) => (
          <li key={item.slug} className={s.item}>
            <time className={s.date} dateTime={item.date}>{item.date}</time>
            <div>
              <h2 className={s.title}>
                <Link href={localizedPath(language, item.path) as Route}>{item.title}</Link>
                {item.approved
                  ? <span className={s.draft}>{c.approved}</span>
                  : item.draft ? <span className={s.draft}>{c.draft}</span> : null}
              </h2>
              <p className={s.summary}>{item.description}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
