import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/data-page";
import d from "@/components/data-page.module.css";
import { bilingual, localizedPath } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { pageMetadata } from "@/lib/seo";
import { publicPreviews } from "@/lib/editorial-store";
import type { Route } from "next";
import s from "../articles.module.css";
import p from "./previews.module.css";

export const dynamic = "force-dynamic";

const copy = bilingual({
  en: {
    title: "Public article previews",
    description: "Bilingual article drafts made public for readers to review. These are separate from the approved Articles section.",
    eyebrow: "PUBLIC PREVIEWS",
    empty: "There are no public previews right now.",
    state: "PUBLIC PREPRINT · NOT APPROVED",
    version: "Version",
  },
  "zh-CN": {
    title: "文章公开预发布",
    description: "供读者阅读和反馈的双语文章预发布稿，与正式文章栏目分开。",
    eyebrow: "公开预发布",
    empty: "目前没有公开预发布文章。",
    state: "公开预发布 · 尚未批准",
    version: "版本",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  const c = copy[language];
  return pageMetadata({ language, path: "/articles/previews", title: c.title, description: c.description });
}

export default async function PreviewDirectory() {
  const { language } = await getLocale();
  const c = copy[language];
  const previews = await publicPreviews(language);
  return (
    <div className={d.page}>
      <PageHeader eyebrow={c.eyebrow} title={c.title} />
      {previews.length === 0 ? <p className={d.note}>{c.empty}</p> : null}
      <ul className={s.list}>
        {previews.map((item) => {
          const path = `/articles/previews/${item.articleId}/v${item.version}`;
          return (
            <li key={`${item.articleId}-${item.version}`} className={s.item}>
              <time className={s.date} dateTime={item.createdAt}>{item.createdAt.slice(0, 10)}</time>
              <div>
                <h2 className={s.title}>
                  <Link href={localizedPath(language, path) as Route}>{item.title}</Link>
                  <span className={s.draft}>{c.version} {item.version}</span>
                </h2>
                <p className={s.summary}>{item.summary}</p>
                <p className={p.publicationState}>{c.state}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
