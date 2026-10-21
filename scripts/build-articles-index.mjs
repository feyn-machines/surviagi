#!/usr/bin/env node
// Writes src/content/articles.json: the published articles, newest first.
//
// The pages themselves are rendered at build time from docs/articles/, but the
// sitemap and llms.txt answer per request on a server that carries no docs/
// folder. They read this list instead. `pnpm i18n:test` fails when the list and
// the documents disagree, so an article cannot be published without it.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANGUAGES = ["en", "zh-CN"];
export const indexPath = join(root, "src", "content", "articles.json");

function header(slug, language) {
  const path = join(root, "docs", "articles", slug, `${language}.md`);
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  const fields = Object.fromEntries(match[1].split("\n").flatMap((line) => {
    const at = line.indexOf(":");
    return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()]] : [];
  }));
  return fields.title && fields.description && /^\d{4}-\d{2}-\d{2}$/.test(fields.date ?? "") ? fields : null;
}

export function articlesIndex() {
  const dir = join(root, "docs", "articles");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const versions = LANGUAGES.map((language) => header(entry.name, language));
      if (versions.some((v) => !v || v.draft === "true")) return [];
      return [{
        slug: entry.name,
        date: versions[0].date,
        title: Object.fromEntries(LANGUAGES.map((l, i) => [l, versions[i].title])),
        description: Object.fromEntries(LANGUAGES.map((l, i) => [l, versions[i].description])),
      }];
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export const indexText = () => JSON.stringify(articlesIndex(), null, 2) + "\n";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(indexPath, indexText());
  console.log(`Wrote ${indexPath}`);
}
