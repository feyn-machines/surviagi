import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEditorialPackage, publishEditorialPreview, EditorialPublishError } from "../editorial-publish.mjs";

const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

async function makePackage(t, edits = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "surviagi-editorial-package-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const en = edits.en ?? "---\ntitle: Article EN\ndescription: Summary EN\ndate: 2026-10-28\n---\n\nText [source](https://example.test/source).\n";
  const zh = edits.zh ?? "---\ntitle: 中文文章\ndescription: 中文摘要\ndate: 2026-10-28\n---\n\n正文[来源](https://example.test/source)。\n";
  const report = "# Private evidence report\nClaim A is checked.\n";
  for (const [name, value] of [["en.md", en], ["zh-CN.md", zh], ["evidence.md", report]]) {
    const file = path.join(root, name);
    await writeFile(file, value, { mode: 0o600 });
    await chmod(file, 0o600);
  }
  const manifest = {
    articleId: "example-article",
    sourceCutoff: "2026-10-28T00:00:00Z",
    createdBy: "editorial-run:0123456789abcdef01234567",
    evidenceGate: edits.evidenceGate ?? "pass",
    bilingualGate: edits.bilingualGate ?? "pass",
    expected: { previewVersion: null, approvedVersion: null },
    evidenceReport: { path: "evidence.md", sha256: hash(report) },
    excludedClaims: edits.excludedClaims ?? [],
    languages: {
      en: { path: "en.md", sha256: hash(en) },
      "zh-CN": { path: "zh-CN.md", sha256: hash(zh) },
    },
  };
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return { root, manifestPath, manifest };
}

test("preflight loader accepts only a private, hash-pinned, bilingual package", async (t) => {
  const pkg = await makePackage(t);
  const bundle = loadEditorialPackage(pkg.manifestPath, { editorialRoot: pkg.root });
  assert.equal(bundle.articleId, "example-article");
  assert.deepEqual(Object.keys(bundle.localizations), ["en", "zh-CN"]);
  assert.equal(bundle.localizations.en.title, "Article EN");
  assert.equal(bundle.localizations["zh-CN"].summary, "中文摘要");
  assert.match(bundle.localizations.en.contentSha256, /^[0-9a-f]{64}$/);
});

test("preflight loader refuses failed gates and held claims copied into public text", async (t) => {
  const failed = await makePackage(t, { evidenceGate: "hold" });
  assert.throws(() => loadEditorialPackage(failed.manifestPath, { editorialRoot: failed.root }), /gates/);
  const held = await makePackage(t, { excludedClaims: ["unsupported claim"] });
  const en = await readFile(path.join(held.root, "en.md"), "utf8");
  await writeFile(path.join(held.root, "en.md"), en.replace("Text", "unsupported claim"), { mode: 0o600 });
  const manifest = JSON.parse(await readFile(held.manifestPath, "utf8"));
  const changed = en.replace("Text", "unsupported claim");
  manifest.languages.en.sha256 = hash(changed);
  await writeFile(held.manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  assert.throws(() => loadEditorialPackage(held.manifestPath, { editorialRoot: held.root }), /held claim/);
});

test("preflight loader detects changed content and cross-language source mismatch", async (t) => {
  const changed = await makePackage(t);
  await writeFile(path.join(changed.root, "en.md"), "changed", { mode: 0o600 });
  assert.throws(() => loadEditorialPackage(changed.manifestPath, { editorialRoot: changed.root }), /hash/);
  const mismatch = await makePackage(t, { zh: "---\ntitle: 中文文章\ndescription: 中文摘要\ndate: 2026-10-28\n---\n\n正文[来源](https://example.test/other)。\n" });
  assert.throws(() => loadEditorialPackage(mismatch.manifestPath, { editorialRoot: mismatch.root }), /same non-empty set/);
});

test("publisher returns a conflict for stale expected pointers", async () => {
  const client = { query: async (sql) => {
    if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM editorial.articles a")) return { rows: [{ preview_version: 2, approved_version: 1, withdrawn_at: null }] };
    if (sql.includes("FROM editorial.localizations")) return { rows: [] };
    if (sql.includes("FROM editorial.versions")) return { rows: [{ source_cutoff: new Date("2026-10-28T00:00:00Z"), created_by: "other-run" }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  await assert.rejects(
    publishEditorialPreview(client, {
      articleId: "example-article", sourceCutoff: "2026-10-28T00:00:00Z", createdBy: "new-run",
      expected: { previewVersion: 1, approvedVersion: 1 }, localizations: { en: {}, "zh-CN": {} },
    }),
    EditorialPublishError,
  );
});
