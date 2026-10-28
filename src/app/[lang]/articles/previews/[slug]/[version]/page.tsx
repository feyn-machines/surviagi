import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/json-ld";
import { bilingual } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { articleLd, breadcrumbLd, pageMetadata } from "@/lib/seo";
import { href } from "@/lib/routes";
import { publicEditorialArticle } from "@/lib/editorial-store";
import { EditorialBody } from "@/components/editorial-body";
import s from "../../../articles.module.css";
import p from "../../previews.module.css";

export const dynamic = "force-dynamic";

const copy = bilingual({
  en: {
    back: "← Public previews",
    list: "Public previews",
    preview: "PUBLIC PREPRINT · NOT APPROVED",
    approved: "APPROVED VERSION",
    version: "Version",
    cutoff: "Evidence cutoff",
  },
  "zh-CN": {
    back: "← 文章公开预发布",
    list: "文章公开预发布",
    preview: "公开预发布 · 尚未批准",
    approved: "已批准版本",
    version: "版本",
    cutoff: "证据截止时间",
  },
});

type Props = { params: Promise<{ slug: string; version: string }> };

function versionNumber(segment: string): number | null {
  const match = /^v([1-9][0-9]*)$/.exec(segment);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { language } = await getLocale();
  const { slug, version } = await params;
  const number = versionNumber(version);
  if (number === null) return {};
  const article = await publicEditorialArticle(slug, number, language);
  if (!article) return {};
  const path = `/articles/previews/${slug}/v${number}`;
  const metadata = pageMetadata({ language, path, title: article.title, description: article.summary, markdown: true });
  return {
    ...metadata,
    openGraph: { ...metadata.openGraph, type: "article", publishedTime: article.createdAt },
  };
}

export default async function PublicPreview({ params }: Props) {
  const { language } = await getLocale();
  const c = copy[language];
  const { slug, version } = await params;
  const number = versionNumber(version);
  if (number === null) notFound();
  const article = await publicEditorialArticle(slug, number, language);
  if (!article) notFound();
  const path = `/articles/previews/${slug}/v${number}`;
  const status = article.status === "approved" ? c.approved : c.preview;
  return (
    <article className={s.article}>
      <JsonLd data={articleLd(language, { headline: article.title, description: article.summary, path, datePublished: article.createdAt })} />
      <JsonLd data={breadcrumbLd(language, [{ name: c.list, path: "/articles/previews" }, { name: article.title, path }])} />
      <Link className={s.back} href={href(language, "/articles/previews")}>{c.back}</Link>
      <h1 className={s.headline}>{article.title}</h1>
      <p className={s.lead}>
        <span className={p.publicationState}>{status}</span>
        <span>{c.version} {article.version}</span>
        <time dateTime={article.sourceCutoff}>{c.cutoff}: {article.sourceCutoff.slice(0, 10)}</time>
      </p>
      <p className={s.lead}>{article.summary}</p>
      <EditorialBody markdown={article.markdown} language={language} />
    </article>
  );
}
