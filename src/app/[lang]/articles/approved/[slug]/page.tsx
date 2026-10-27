import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/json-ld";
import { bilingual, localizedPath, type Language } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { articleLd, breadcrumbLd, pageMetadata } from "@/lib/seo";
import { approvedEditorialArticle } from "@/lib/editorial-store";
import { parseBlocks, type Block, type Inline } from "@/lib/whitepaper";
import s from "../../articles.module.css";

export const dynamic = "force-dynamic";

const copy = bilingual({
  en: { back: "← All articles", list: "Articles", approved: "APPROVED VERSION", version: "Version" },
  "zh-CN": { back: "← 全部文章", list: "文章", approved: "已批准版本", version: "版本" },
});

type Props = { params: Promise<{ slug: string }> };
type TableBlock = { kind: "table"; rows: Inline[][][] };
type EditorialBlock = Block | TableBlock;

function parseEditorialMarkdown(markdown: string): EditorialBlock[] {
  const lines = markdown.split("\n");
  const blocks: EditorialBlock[] = [];
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
  for (let index = 0; index < lines.length; index += 1) {
    if (!isRow(lines[index]) || !lines[index + 1] || !isDivider(lines[index + 1])) {
      prose.push(lines[index]);
      continue;
    }
    flushProse();
    const rows = [cells(lines[index])];
    index += 2;
    while (index < lines.length && isRow(lines[index])) rows.push(cells(lines[index++]));
    index -= 1;
    blocks.push({ kind: "table", rows: rows.map((row) => row.map(cellInline)) });
  }
  flushProse();
  return blocks;
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

function renderBlock(block: EditorialBlock, index: number, language: Language) {
  const key = `approved-${index}`;
  switch (block.kind) {
    case "rule": return <hr key={key} />;
    case "heading": {
      const Tag = block.level <= 2 ? "h2" : "h3";
      return <Tag key={key}>{inline(block.inline, key, language)}</Tag>;
    }
    case "list": return <ol key={key}>{block.items.map((row, i) => <li key={`${key}-${i}`}>{inline(row, `${key}-${i}`, language)}</li>)}</ol>;
    case "bullets": return <ul key={key}>{block.items.map((row, i) => <li key={`${key}-${i}`}>{inline(row, `${key}-${i}`, language)}</li>)}</ul>;
    case "table": return <div key={key} style={{ maxWidth: "100%", overflowX: "auto", marginBottom: "var(--ah-space-5)" }} role="region" aria-label="Article table" tabIndex={0}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px", lineHeight: 1.55 }}><thead><tr>{block.rows[0]?.map((cell, i) => <th key={`${key}-h${i}`} scope="col" style={{ padding: "12px 14px", borderBottom: "1px solid var(--ah-color-line)", textAlign: "left", verticalAlign: "top" }}>{inline(cell, `${key}-h${i}`, language)}</th>)}</tr></thead><tbody>{block.rows.slice(1).map((row, i) => <tr key={`${key}-r${i}`}>{row.map((cell, j) => <td key={`${key}-r${i}-c${j}`} style={{ padding: "12px 14px", borderBottom: "1px solid var(--ah-color-line)", textAlign: "left", verticalAlign: "top" }}>{inline(cell, `${key}-r${i}-c${j}`, language)}</td>)}</tr>)}</tbody></table></div>;
    case "image":
      // eslint-disable-next-line @next/next/no-img-element
      return <img key={key} className={s.figure} src={block.src} alt={block.alt} loading="lazy" />;
    default: return <p key={key}>{inline(block.inline, key, language)}</p>;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { language } = await getLocale();
  const { slug } = await params;
  const article = await approvedEditorialArticle(slug, language);
  if (!article) return {};
  const path = `/articles/approved/${slug}`;
  const metadata = pageMetadata({ language, path, title: article.title, description: article.summary, markdown: true });
  return {
    ...metadata,
    openGraph: { ...metadata.openGraph, type: "article", publishedTime: article.createdAt },
  };
}

export default async function ApprovedArticle({ params }: Props) {
  const { language } = await getLocale();
  const c = copy[language];
  const { slug } = await params;
  const article = await approvedEditorialArticle(slug, language);
  if (!article) notFound();
  const path = `/articles/approved/${slug}`;
  return (
    <article className={s.article}>
      <JsonLd data={articleLd(language, { headline: article.title, description: article.summary, path, datePublished: article.createdAt })} />
      <JsonLd data={breadcrumbLd(language, [{ name: c.list, path: "/articles" }, { name: article.title, path }])} />
      <Link className={s.back} href={localizedPath(language, "/articles") as Route}>{c.back}</Link>
      <h1 className={s.headline}>{article.title}</h1>
      <p className={s.lead}>
        <span>{c.approved}</span>
        <span>{c.version} {article.version}</span>
        <time dateTime={article.createdAt}>{article.createdAt.slice(0, 10)}</time>
      </p>
      <p className={s.lead}>{article.summary}</p>
      <div className={s.body}>{parseEditorialMarkdown(article.markdown).map((block, index) => renderBlock(block, index, language))}</div>
    </article>
  );
}
