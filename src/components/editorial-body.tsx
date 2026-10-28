import type { Route } from "next";
import Link from "next/link";
import { localizedPath, type Language } from "@/lib/i18n";
import { parseBlocks, type Block, type Inline } from "@/lib/whitepaper";
import s from "@/app/[lang]/articles/articles.module.css";
import p from "@/app/[lang]/articles/previews/previews.module.css";

type TableBlock = { kind: "table"; rows: Inline[][][] };
type PreviewBlock = Block | TableBlock;

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
      return <div key={key} className={p.tableScroll} role="region" aria-label={language === "en" ? "Article table" : "文章表格"} tabIndex={0}><table><thead><tr>{block.rows[0]?.map((cell, i) => <th key={`${key}-h${i}`} scope="col">{inline(cell, `${key}-h${i}`, language)}</th>)}</tr></thead><tbody>{block.rows.slice(1).map((row, i) => <tr key={`${key}-r${i}`}>{row.map((cell, j) => <td key={`${key}-r${i}-c${j}`}>{inline(cell, `${key}-r${i}-c${j}`, language)}</td>)}</tr>)}</tbody></table></div>;
    case "image":
      // eslint-disable-next-line @next/next/no-img-element
      return <img key={key} className={s.figure} src={block.src} alt={block.alt} loading="lazy" />;
    default: return <p key={key}>{inline(block.inline, key, language)}</p>;
  }
}

/** Shared server-rendered body: the review desk and reader see identical formatting. */
export function EditorialBody({ markdown, language }: { markdown: string; language: Language }) {
  return <div className={s.body}>{parseEditorialMarkdown(markdown).map((block, index) => renderBlock(block, index, language))}</div>;
}
