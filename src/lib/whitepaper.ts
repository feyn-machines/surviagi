import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Language } from "./i18n";

/**
 * The whitepaper lives in docs/whitepaper.md as one bilingual file with the two
 * versions behind anchors. The site renders one language at a time - stacking
 * both on one page is what the language rule exists to prevent - so this splits
 * the file and parses the small subset of Markdown the document actually uses:
 * headings, ordered lists, a rule, bold, links and hard line breaks. No
 * dependency is added for it, and nothing is rendered as raw HTML.
 */

const WHITEPAPER_PATH = join(process.cwd(), "docs", "whitepaper.md");

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "break" };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; id?: string; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; items: Inline[][] }
  | { kind: "bullets"; items: Inline[][] }
  | { kind: "rule" }
  | { kind: "image"; alt: string; src: string };

const ANCHOR = /<a id="([^"]+)"><\/a>/g;

/** The document's own section markers, so a rename in the file is visible here. */
const SECTION_ANCHOR: Record<Language, string> = { en: "english", "zh-CN": "zh-cn" };

export const whitepaperExists = existsSync(WHITEPAPER_PATH);

function sectionFor(source: string, language: Language): string {
  const anchors = [...source.matchAll(ANCHOR)].map((m) => ({ id: m[1], at: m.index ?? 0 }));
  const wanted = SECTION_ANCHOR[language];
  const start = anchors.find((a) => a.id === wanted);
  if (!start) return "";
  // The next *section* anchor, not the next anchor of any kind: footnote targets
  // sit inside a section and must not end it.
  const sectionIds = Object.values(SECTION_ANCHOR);
  const next = anchors.find((a) => a.at > start.at && sectionIds.includes(a.id));
  return source.slice(start.at, next ? next.at : undefined);
}

function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  // Ordered so the first match wins at each position.
  const pattern = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  const push = (raw: string) => {
    if (raw) out.push({ kind: "text", text: raw });
  };
  while ((match = pattern.exec(text)) !== null) {
    push(text.slice(last, match.index));
    if (match[2] !== undefined) out.push({ kind: "strong", text: match[2] });
    else if (match[4] !== undefined) out.push({ kind: "em", text: match[4] });
    else out.push({ kind: "link", text: match[6], href: match[7] });
    last = match.index + match[0].length;
  }
  push(text.slice(last));
  return out;
}

/** A line ending in two spaces is a hard break in Markdown; the document uses it. */
function parseInlineLines(lines: string[]): Inline[] {
  const inline: Inline[] = [];
  lines.forEach((line, index) => {
    inline.push(...parseInline(line.replace(/\s+$/, "")));
    if (index < lines.length - 1) inline.push({ kind: "break" });
  });
  return inline;
}

export function whitepaperBlocks(language: Language): Block[] {
  if (!whitepaperExists) return [];
  const section = sectionFor(readFileSync(WHITEPAPER_PATH, "utf8"), language);
  if (!section) return [];
  return parseBlocks(section);
}

/**
 * One language of the whitepaper as the Markdown it was written in, for the
 * page's Markdown copy: the anchors that are only targets are left out, and a
 * link into the document (`#…`) or the site (`/…`) is given its whole address,
 * `page` being the whitepaper's own address in that language.
 */
export function whitepaperMarkdown(language: Language, page: string, site: string): string {
  if (!whitepaperExists) return "";
  const section = sectionFor(readFileSync(WHITEPAPER_PATH, "utf8"), language);
  return section
    .replace(/^\s*<a id="[^"]+"><\/a>\s*\n/gm, "")
    .replace(/<a id="[^"]+"><\/a>/g, "")
    .replace(/\]\((#[^)]*)\)/g, (_, anchor: string) => `](${page}${anchor})`)
    .replace(/\]\((\/[^)]*)\)/g, (_, path: string) => `](${site}${path})`)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    // The rule that only separates the two languages in the file ends nothing in one of them.
    .replace(/\n+---+$/, "")
    // The edition's title is the document's title.
    .replace(/^## /, "# ");
}

/**
 * The subset of Markdown the site's own documents use, as blocks. `bullets`
 * turns on unordered lists, which articles use and the whitepaper does not: a
 * line of the whitepaper that happens to begin with a dash stays a paragraph.
 * `images` turns on a figure: a line that is only `![alt](/path)`, the path
 * being a file the site serves itself.
 */
export function parseBlocks(section: string, options: { bullets?: boolean; images?: boolean } = {}): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inline: parseInlineLines(paragraph) });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ kind: "list", items: list.map((item) => parseInline(item)) });
    if (bullets.length) blocks.push({ kind: "bullets", items: bullets.map((item) => parseInline(item)) });
    list = [];
    bullets = [];
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (const raw of section.split("\n")) {
    // Anchors are targets, not content; the heading that follows carries the id.
    const anchorOnly = raw.trim().match(/^<a id="([^"]+)"><\/a>$/);
    if (anchorOnly) {
      flush();
      blocks.push({ kind: "heading", level: 2, id: anchorOnly[1], inline: [] });
      continue;
    }
    const line = raw.replace(/<a id="[^"]+"><\/a>/g, "");
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const image = options.images ? line.trim().match(/^!\[([^\]]*)\]\((\/[^)\s]+)\)$/) : null;
    if (image) {
      flush();
      blocks.push({ kind: "image", alt: image[1], src: image[2] });
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        inline: parseInline(heading[2].trim()),
      });
      continue;
    }
    const item = line.match(/^\s*\d+\.\s+(.*)$/);
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }
    const bullet = options.bullets ? line.match(/^\s*-\s+(.*)$/) : null;
    if (bullet) {
      flushParagraph();
      bullets.push(bullet[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flush();

  // An empty heading is a bare anchor; keep it as a target but render no text.
  return blocks.filter((b) => b.kind !== "heading" || b.id || b.inline.length);
}
