import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/data-page";
import d from "@/components/data-page.module.css";
import { listedArticles } from "@/lib/article-list";
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
    approved: "APPROVED",
  },
  "zh-CN": {
    metaTitle: "文章",
    metaDescription: "AI 在真实工作上发生了什么变化，取自各家的更新和人们自述用它做了什么。",
    eyebrow: "文章",
    title: "文章",
    empty: "暂无文章。",
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
  const list = await listedArticles(language);
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
                {item.approved ? <span className={s.draft}>{c.approved}</span> : null}
              </h2>
              <p className={s.summary}>{item.description}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
