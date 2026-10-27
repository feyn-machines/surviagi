import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/json-ld";
import { bilingual, localizedPath, type Language } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { articleLd, breadcrumbLd, pageMetadata } from "@/lib/seo";
import { href } from "@/lib/routes";
import { publicEditorialArticle } from "@/lib/editorial-store";
import { parseBlocks, type Block, type Inline } from "@/lib/whitepaper";
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
type TableBlock = { kind: "table"; rows: Inline[][][] };
type PreviewBlock = Block | TableBlock;

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

function inline(parts: Inline[], prefix: string, language: Language) {
  return parts.map((part, index) => {
    const key = `${prefix}-${index}`;
    switch (part.kind) {
      case "strong": return <strong key={key}>{part.text}</strong>;
      case "em": return <em key={key}>{part.text}</em>;
      case "break": return <br key={key} />;
      case "link":
        return part.href.startsWith("http")
          ? <a key={key} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
          : <Link key={key} href={localizedPath(language, part.href) as Route}>{part.text}</Link>;
      default: return <span key={key}>{part.text}</span>;
    }
  });
}

function parseEditorialMarkdown(markdown: string): PreviewBlock[] {
  const lines = markdown.split("\n");
  const blocks: PreviewBlock[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length) blocks.push(...parseBlocks(prose.join("\n"), { bullets: true, images: true }));
    prose = [];
  };
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
  const isDivider = (line: string) => isRow(line) && cells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
  const cellInline = (cell: string): Inline[] => {
    const first = parseBlocks(cell)[0];
    return first?.kind === "paragraph" ? first.inline : [{ kind: "text", text: cell }];
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (!isRow(lines[i]) || !lines[i + 1] || !isDivider(lines[i + 1])) {
      prose.push(lines[i]);
      continue;
    }
    flushProse();
    const rows = [cells(lines[i])];
    i += 2;
    while (i < lines.length && isRow(lines[i])) {
      rows.push(cells(lines[i]));
      i += 1;
    }
    i -= 1;
    blocks.push({ kind: "table", rows: rows.map((row) => row.map(cellInline)) });
  }
  flushProse();
  return blocks;
}

function renderBlock(block: PreviewBlock, index: number, language: Language) {
  const key = `preview-${index}`;
  switch (block.kind) {
    case "rule": return <hr key={key} />;
    case "heading": {
      const Tag = block.level <= 2 ? "h2" : "h3";
      return <Tag key={key}>{inline(block.inline, key, language)}</Tag>;
    }
    case "list":
      return <ol key={key}>{block.items.map((row, i) => <li key={`${key}-${i}`}>{inline(row, `${key}-${i}`, language)}</li>)}</ol>;
    case "bullets":
      return <ul key={key}>{block.items.map((row, i) => <li key={`${key}-${i}`}>{inline(row, `${key}-${i}`, language)}</li>)}</ul>;
    case "table":
      return <div key={key} className={p.tableScroll} role="region" aria-label="Article table" tabIndex={0}><table><thead><tr>{block.rows[0]?.map((cell, i) => <th key={`${key}-h${i}`} scope="col">{inline(cell, `${key}-h${i}`, language)}</th>)}</tr></thead><tbody>{block.rows.slice(1).map((row, i) => <tr key={`${key}-r${i}`}>{row.map((cell, j) => <td key={`${key}-r${i}-c${j}`}>{inline(cell, `${key}-r${i}-c${j}`, language)}</td>)}</tr>)}</tbody></table></div>;
    case "image":
      // eslint-disable-next-line @next/next/no-img-element
      return <img key={key} className={s.figure} src={block.src} alt={block.alt} loading="lazy" />;
    default: return <p key={key}>{inline(block.inline, key, language)}</p>;
  }
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
  const blocks = parseEditorialMarkdown(article.markdown);
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
      <div className={s.body}>{blocks.map((block, index) => renderBlock(block, index, language))}</div>
    </article>
  );
}
