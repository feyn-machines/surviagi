/**
 * Guards on text the reader sees, checked against the data that actually
 * reaches the site.
 *
 * These exist because three separate bugs shipped past a green typecheck: a
 * count key the publisher emits and the label map did not define, so the site
 * printed `gate_tasks` at readers in both languages; a provenance marker that
 * told Chinese readers "only Chinese was published" over English text; and a
 * root layout whose metadata was English for everyone. None of them is a type
 * error, and none is visible without comparing source against snapshot.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)), "utf8");
/**
 * The manifest of the local published snapshot. `pnpm data:publish:snapshot`
 * writes it into a gitignored directory, so a fresh clone has none. Reading it
 * lazily lets the other tests in this file run without a snapshot, and the one
 * test that compares against it skips instead of aborting the whole file at
 * import time.
 */
function snapshotManifest() {
  const path = "datasets/published/latest/manifest.json";
  if (!existsSync(fileURLToPath(new URL(path, root)))) return null;
  return JSON.parse(read(path));
}

/** Every page that exists, so deleting a route never fails a test by name. */
function pages(dir = "src/app") {
  const out = [];
  for (const entry of readdirSync(fileURLToPath(new URL(dir, root)), { withFileTypes: true })) {
    const next = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...pages(next));
    else if (entry.name === "page.tsx") out.push(next);
  }
  return out;
}

test("every count the publisher emits has a label in both languages", (t) => {
  const manifest = snapshotManifest();
  if (!manifest) {
    t.skip("no datasets/published/latest/manifest.json; run `pnpm data:publish:snapshot`");
    return;
  }
  const source = read("src/components/data-page.tsx");
  const block = source.slice(source.indexOf("const countLabels = bilingual({"));
  const english = block.slice(block.indexOf("en: {"), block.indexOf('"zh-CN": {'));
  const chinese = block.slice(block.indexOf('"zh-CN": {'), block.indexOf("});"));
  for (const key of Object.keys(manifest.counts)) {
    // A dotted key ("chain.events") is not a valid bare identifier, so it is
    // written quoted. Both spellings are the same label.
    const spellings = [`${key}:`, `"${key}":`];
    assert.ok(spellings.some((form) => english.includes(form)),
      `no English label for manifest count "${key}"`);
    assert.ok(spellings.some((form) => chinese.includes(form)),
      `no Chinese label for manifest count "${key}"`);
  }
});

test("the original-language marker names the language it is actually showing", () => {
  const source = read("src/components/data-page.tsx");
  const block = source.slice(source.indexOf("export function OriginalLanguage"));
  // Reading an English page that fell back to Chinese, and the reverse. The bug
  // this replaces had one sentence for both directions, so one of them lied.
  assert.match(block, /shown === "zh-CN"[\s\S]{0,200}Published in Chinese only/);
  assert.match(block, /Published in English only/);
  assert.match(block, /shown === "en"[\s\S]{0,200}只发布了英文/);
  assert.match(block, /只发布了中文/);
  // And it says nothing at all when the text is in the reader's own language.
  assert.match(block, /if \(shown === reading\) return null;/);
});

test("no page states a language marker of its own", () => {
  // The per-page `originalZh` strings were what made the inversion possible:
  // six copies of one sentence, each assuming the fallback direction.
  for (const path of pages()) {
    assert.ok(!read(path).includes("originalZh"), `${path} still carries its own marker`);
  }
});

test("the root layout resolves metadata per reader rather than statically", () => {
  const source = read("src/app/[lang]/layout.tsx");
  assert.ok(
    source.includes("export async function generateMetadata"),
    "a static `metadata` object cannot see the reader's language",
  );
  assert.ok(!/export const metadata/.test(source), "static metadata is still exported");
  // The words themselves live in `siteCopy`; the layout must take them from there.
  assert.ok(source.includes("siteCopy[language]"), "the layout does not use the shared site copy");
  assert.ok(read("src/lib/seo.ts").includes("每一次 AI 更新"), "no Chinese description");
  // The confirmed headline stays the default title in both languages.
  assert.ok(!source.includes("Will AI Kill Your Idea?"), "the retired title is back");
});

test("update chronology prefers occurrence, labels source announcements and preserves missing dates", async () => {
  const ts = (await import("typescript")).default;
  const js = ts.transpileModule(read("src/lib/update-date.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { updateTimestamp, updateDateLabel } = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(js)}`);
  const occurred = { occurred_at: "2026-01-02T08:00:00Z", announced_at: "2026-01-03T09:00:00Z" };
  const announced = { occurred_at: null, announced_at: "2026-01-03T09:00:00Z" };
  const missing = { occurred_at: null };
  assert.equal(updateTimestamp(occurred), occurred.occurred_at);
  assert.equal(updateDateLabel(occurred, "en"), "2026-01-02");
  assert.equal(updateTimestamp(announced), announced.announced_at);
  assert.equal(updateDateLabel(announced, "en"), "Announced 2026-01-03");
  assert.equal(updateDateLabel(announced, "zh-CN"), "2026-01-03 宣布");
  assert.equal(updateTimestamp(missing), null);
  assert.equal(updateDateLabel(missing, "en"), null);
  assert.equal(announced.occurred_at, null, "display chronology must not rewrite event facts");
});
