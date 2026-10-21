import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { articlesIndex, indexPath, indexText } from "../build-articles-index.mjs";

test("the article list the sitemap reads is the one the documents give", () => {
  assert.ok(existsSync(indexPath), "run pnpm articles:index");
  assert.equal(readFileSync(indexPath, "utf8"), indexText(), "src/content/articles.json has drifted; run pnpm articles:index");
});

test("every listed article has a title and a description in both languages, and a date", () => {
  for (const article of articlesIndex()) {
    assert.match(article.slug, /^[a-z0-9][a-z0-9-]*$/);
    assert.match(article.date, /^\d{4}-\d{2}-\d{2}$/);
    for (const language of ["en", "zh-CN"]) {
      assert.ok(article.title[language], `${article.slug} title ${language}`);
      assert.ok(article.description[language], `${article.slug} description ${language}`);
    }
  }
});
