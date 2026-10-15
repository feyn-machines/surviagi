import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/json-ld";
import { article, articles } from "@/lib/articles";
import { bilingual, LANGUAGES, localizedPath, type Language } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { absoluteUrl, articleLd, breadcrumbLd, pageMetadata } from "@/lib/seo";
import type { Block, Inline } from "@/lib/whitepaper";
import s from "../articles.module.css";

/**
 * One article, rendered at build time from its Markdown file. Only the slugs
 * that exist in every language are generated; any other address is a 404.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  const slugs = new Set(LANGUAGES.flatMap((language) => articles(language).map((item) => item.slug)));
  return [...slugs].map((slug) => ({ slug }));
}

const copy = bilingual({
  en: { back: "← All articles", list: "Articles", draft: "DRAFT" },
  "zh-CN": { back: "← 全部文章", list: "文章", draft: "草稿" },
});

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { language } = await getLocale();
  const found = article((await params).slug, language);
  if (!found) return {};
  const metadata = pageMetadata({ language, path: `/articles/${found.slug}`, title: found.title, description: found.description });
  return {
    ...metadata,
    alternates: {
      ...metadata.alternates,
      // The same text for programs, and the feed it will appear in.
      types: {
        "text/markdown": absoluteUrl(language, `/articles/${found.slug}/raw.md`),
        "application/rss+xml": absoluteUrl(language, "/articles/feed.xml"),
      },
    },
    openGraph: { ...metadata.openGraph, type: "article", publishedTime: found.date },
  };
}

function inline(parts: Inline[], prefix: string, language: Language) {
  return parts.map((part, i) => {
    const key = `${prefix}-${i}`;
    switch (part.kind) {
      case "strong":
        return <strong key={key}>{part.text}</strong>;
      case "em":
        return <em key={key}>{part.text}</em>;
      case "break":
        return <br key={key} />;
      case "link":
        // A source is an outside address and opens beside the article; a link
        // into the site stays in it.
        // The document writes a site page without its language; the reader's is added here.
        return part.href.startsWith("http") ? (
          <a key={key} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
        ) : (
          <Link key={key} href={localizedPath(language, part.href) as Route}>{part.text}</Link>
        );
      default:
        return <span key={key}>{part.text}</span>;
    }
  });
}

function block(item: Block, i: number, language: Language) {
  const key = `b${i}`;
  switch (item.kind) {
    case "rule":
      return <hr key={key} />;
    case "image":
      // A figure the site serves itself, often an animated GIF, which the image optimizer would flatten.
      // eslint-disable-next-line @next/next/no-img-element
      return <img key={key} className={s.figure} src={item.src} alt={item.alt} loading="lazy" />;
    case "list":
      return <ol key={key}>{item.items.map((row, j) => <li key={`${key}-${j}`}>{inline(row, `${key}-${j}`, language)}</li>)}</ol>;
    case "bullets":
      return <ul key={key}>{item.items.map((row, j) => <li key={`${key}-${j}`}>{inline(row, `${key}-${j}`, language)}</li>)}</ul>;
    case "heading": {
      // The page's own h1 is the title, so the document's headings start at h2.
      const Tag = item.level <= 2 ? "h2" : "h3";
      return <Tag key={key}>{inline(item.inline, key, language)}</Tag>;
    }
    default:
      return <p key={key}>{inline(item.inline, key, language)}</p>;
  }
}

export default async function ArticlePage({ params }: Props) {
  const { language } = await getLocale();
  const c = copy[language];
  const found = article((await params).slug, language);
  if (!found) notFound();
  const path = `/articles/${found.slug}`;
  return (
    <article className={s.article}>
      <JsonLd data={articleLd(language, { headline: found.title, description: found.description, path, datePublished: found.date })} />
      <JsonLd data={breadcrumbLd(language, [{ name: c.list, path: "/articles" }, { name: found.title, path }])} />
      <Link className={s.back} href={localizedPath(language, "/articles") as Route}>{c.back}</Link>
      <h1 className={s.headline}>{found.title}</h1>
      <p className={s.lead}>
        <time dateTime={found.date}>{found.date}</time>
        {found.draft ? <span className={s.draft}>{c.draft}</span> : null}
      </p>
      <div className={s.body}>{found.blocks.map((item, i) => block(item, i, language))}</div>
    </article>
  );
}
