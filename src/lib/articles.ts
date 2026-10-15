import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES, type Language } from "./i18n";
import { parseBlocks, type Block } from "./whitepaper";

/**
 * Public articles. Each one is a folder under docs/articles/ holding one
 * Markdown file per language, with a short header: title, description, date,
 * and `draft: true` while it is not ready.
 *
 * Like the whitepaper, an article is part of the build, not of a data release:
 * the server carries no docs/ folder, so these pages are rendered at build time
 * and publishing one is a code release. An article exists only when every
 * language has its file - the site never shows one language standing in for
 * another. A draft is shown by the development server and left out of a build.
 */
const ARTICLES_DIR = join(process.cwd(), "docs", "articles");
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SHOW_DRAFTS = process.env.NODE_ENV !== "production";

export type ArticleMeta = { slug: string; title: string; description: string; date: string; draft: boolean };
export type Article = ArticleMeta & { blocks: Block[]; markdown: string };

function read(slug: string, language: Language): Article | null {
  const path = join(ARTICLES_DIR, slug, `${language}.md`);
  if (!SLUG.test(slug) || !existsSync(path)) return null;
  const source = readFileSync(path, "utf8");
  const header = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!header) return null;
  const fields = Object.fromEntries(
    header[1].split("\n").flatMap((line) => {
      const at = line.indexOf(":");
      return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()]] : [];
    }),
  );
  if (!fields.title || !fields.description || !/^\d{4}-\d{2}-\d{2}$/.test(fields.date ?? "")) return null;
  const markdown = source.slice(header[0].length).trim();
  return {
    slug,
    title: fields.title,
    description: fields.description,
    date: fields.date,
    draft: fields.draft === "true",
    blocks: parseBlocks(markdown, { bullets: true, images: true }),
    markdown,
  };
}

/** Every article that exists in all languages, newest first. */
export function articles(language: Language): ArticleMeta[] {
  if (!existsSync(ARTICLES_DIR)) return [];
  return readdirSync(ARTICLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const versions = LANGUAGES.map((l) => read(entry.name, l));
      if (versions.some((v) => !v) || (!SHOW_DRAFTS && versions.some((v) => v?.draft))) return [];
      const { slug, title, description, date, draft } = versions[LANGUAGES.indexOf(language)] as Article;
      return [{ slug, title, description, date, draft }];
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export function article(slug: string, language: Language): Article | null {
  return articles(language).some((item) => item.slug === slug) ? read(slug, language) : null;
}
