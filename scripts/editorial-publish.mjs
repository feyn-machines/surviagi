#!/usr/bin/env node
/** Publish a preflighted bilingual package to the loopback-only local editorial store. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDITORIAL_ROOT = resolve(ROOT, "data/editorial");
const PASSWORD_PATH = resolve(ROOT, "data/postgres/password");
const ARTICLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LANGUAGES = ["en", "zh-CN"];
const MAX_MARKDOWN_BYTES = 96 * 1024;

export class EditorialPublishError extends Error {}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function readPrivateFile(path, expectedRoot) {
  let real;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new EditorialPublishError("symbolic links are not accepted in editorial packages");
    real = realpathSync(path);
  } catch {
    throw new EditorialPublishError("package file does not exist");
  }
  if (!within(expectedRoot, real)) throw new EditorialPublishError("package files must stay inside data/editorial");
  const info = statSync(real);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new EditorialPublishError("package and evidence files must be regular and private (mode 0600 or stricter)");
  }
  return readFileSync(real, "utf8");
}

function parseMarkdown(source, language) {
  if (Buffer.byteLength(source, "utf8") > MAX_MARKDOWN_BYTES) {
    throw new EditorialPublishError(`${language} Markdown exceeds the 96 KiB limit`);
  }
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new EditorialPublishError(`${language} Markdown must have title, description and date frontmatter`);
  const fields = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    if (Object.hasOwn(fields, key)) throw new EditorialPublishError(`${language} frontmatter repeats ${key}`);
    fields[key] = line.slice(at + 1).trim();
  }
  if (!fields.title || !fields.description || !/^\d{4}-\d{2}-\d{2}$/.test(fields.date ?? "")) {
    throw new EditorialPublishError(`${language} frontmatter has invalid title, description or date`);
  }
  const body = match[2].trim();
  if (!body) throw new EditorialPublishError(`${language} article body is empty`);
  return {
    title: fields.title,
    summary: fields.description,
    body,
    contentSha256: sha256(body),
    date: fields.date,
  };
}

export function loadEditorialPackage(manifestPath, {
  editorialRoot = EDITORIAL_ROOT,
  evidenceGate = "pass",
  bilingualGate = "pass",
} = {}) {
  const editorialRootReal = realpathSync(editorialRoot);
  const manifestSource = readPrivateFile(manifestPath, editorialRootReal);
  let manifest;
  try {
    manifest = JSON.parse(manifestSource);
  } catch {
    throw new EditorialPublishError("manifest must be valid JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new EditorialPublishError("manifest must be an object");
  }
  if (evidenceGate !== "pass" || bilingualGate !== "pass") {
    throw new EditorialPublishError("both evidence and cross-language gates must pass before publishing");
  }
  if (manifest.evidenceGate !== "pass" || manifest.bilingualGate !== "pass") {
    throw new EditorialPublishError("manifest must record passing evidence and cross-language gates");
  }
  if (typeof manifest.articleId !== "string" || !ARTICLE_ID.test(manifest.articleId)) {
    throw new EditorialPublishError("manifest has an invalid articleId");
  }
  if (typeof manifest.createdBy !== "string" || !/^[a-zA-Z0-9:_-]{1,120}$/.test(manifest.createdBy)) {
    throw new EditorialPublishError("manifest has an invalid createdBy value");
  }
  if (typeof manifest.sourceCutoff !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.sourceCutoff)
      || Number.isNaN(Date.parse(manifest.sourceCutoff))) {
    throw new EditorialPublishError("manifest has an invalid sourceCutoff timestamp");
  }
  const validPointer = (value) => value === null || (Number.isSafeInteger(value) && value > 0);
  if (!manifest.expected || !validPointer(manifest.expected.previewVersion) || !validPointer(manifest.expected.approvedVersion)) {
    throw new EditorialPublishError("manifest must state expected preview and approved versions (null or a positive integer)");
  }
  if (!manifest.evidenceReport || typeof manifest.evidenceReport.path !== "string"
      || !SHA256.test(manifest.evidenceReport.sha256 ?? "")) {
    throw new EditorialPublishError("manifest must include a hash-pinned private evidence report");
  }
  const manifestDir = dirname(realpathSync(manifestPath));
  const evidencePath = resolve(manifestDir, manifest.evidenceReport.path);
  if (!within(editorialRootReal, evidencePath)) throw new EditorialPublishError("evidence report must stay inside data/editorial");
  const evidence = readPrivateFile(evidencePath, editorialRootReal);
  if (sha256(evidence) !== manifest.evidenceReport.sha256) {
    throw new EditorialPublishError("evidence report hash does not match the manifest");
  }
  if (!Array.isArray(manifest.excludedClaims)) throw new EditorialPublishError("manifest must list excludedClaims, or use an empty list");
  const localizations = {};
  const manifestHashes = {};
  for (const language of LANGUAGES) {
    const entry = manifest.languages?.[language];
    if (!entry || typeof entry.path !== "string" || !SHA256.test(entry.sha256 ?? "")) {
      throw new EditorialPublishError(`manifest is missing the ${language} path or SHA-256`);
    }
    const markdownPath = resolve(manifestDir, entry.path);
    if (!within(editorialRootReal, markdownPath)) throw new EditorialPublishError(`${language} article must stay inside data/editorial`);
    const source = readPrivateFile(markdownPath, editorialRootReal);
    if (sha256(source) !== entry.sha256) throw new EditorialPublishError(`${language} article hash does not match the manifest`);
    const parsed = parseMarkdown(source, language);
    if (parsed.date !== manifest.sourceCutoff.slice(0, 10)) {
      throw new EditorialPublishError(`${language} article date must match sourceCutoff`);
    }
    for (const claim of manifest.excludedClaims) {
      if (typeof claim !== "string" || claim.length < 2) throw new EditorialPublishError("excluded claim markers must be non-empty strings");
      if (source.includes(claim)) throw new EditorialPublishError(`held claim marker appears in ${language} article`);
    }
    manifestHashes[language] = entry.sha256;
    localizations[language] = parsed;
  }
  const linkSets = Object.fromEntries(LANGUAGES.map((language) => [
    language,
    [...localizations[language].body.matchAll(/\[[^\]]*\]\((https:\/\/[^)]+)\)/g)].map((match) => match[1]).sort(),
  ]));
  if (linkSets.en.length === 0 || JSON.stringify(linkSets.en) !== JSON.stringify(linkSets["zh-CN"])) {
    throw new EditorialPublishError("both languages must cite the same non-empty set of HTTPS sources");
  }
  return {
    articleId: manifest.articleId,
    sourceCutoff: manifest.sourceCutoff,
    createdBy: manifest.createdBy,
    expected: manifest.expected,
    manifestSha256: sha256(manifestSource),
    evidenceReportSha256: manifest.evidenceReport.sha256,
    excludedClaims: [...manifest.excludedClaims],
    manifestHashes,
    localizations,
  };
}

function pointerMatches(expected, current) {
  return expected === current;
}

function sameContent(existing, bundle) {
  return LANGUAGES.every((language) => {
    const current = existing[language];
    const candidate = bundle.localizations[language];
    return current && current.title === candidate.title && current.summary === candidate.summary
      && current.body_markdown === candidate.body && current.content_sha256 === candidate.contentSha256;
  });
}

/**
 * Atomically write a fully checked bilingual version and move only the preview pointer.
 * The caller supplies a transaction-capable writer connection (local or isolated test DB).
 */
export async function publishEditorialPreview(client, bundle) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [bundle.articleId]);
    const pointerRows = await client.query(
      `SELECT p.preview_version, p.approved_version, a.withdrawn_at
         FROM editorial.articles a
         JOIN editorial.publications p USING (article_id)
        WHERE a.article_id = $1 FOR UPDATE OF p, a`,
      [bundle.articleId],
    );
    const pointers = pointerRows.rows[0] ?? null;
    if (pointers?.withdrawn_at) throw new EditorialPublishError("withdrawn articles cannot receive a new preview");

    if (pointers?.preview_version !== null && pointers?.preview_version !== undefined) {
      const existingRows = await client.query(
        `SELECT l.language, l.title, l.summary, l.body_markdown, l.content_sha256
           FROM editorial.localizations l
          WHERE l.article_id = $1 AND l.version = $2`,
        [bundle.articleId, pointers.preview_version],
      );
      const existing = Object.fromEntries(existingRows.rows.map((row) => [row.language, row]));
      const oldVersion = await client.query(
        "SELECT source_cutoff, created_by FROM editorial.versions WHERE article_id = $1 AND version = $2",
        [bundle.articleId, pointers.preview_version],
      );
      if (oldVersion.rows[0] && oldVersion.rows[0].source_cutoff.toISOString() === new Date(bundle.sourceCutoff).toISOString()
          && oldVersion.rows[0].created_by === bundle.createdBy && sameContent(existing, bundle)) {
        await client.query("COMMIT");
        return { created: false, articleId: bundle.articleId, version: pointers.preview_version,
          approvedVersion: pointers.approved_version, contentSha256: Object.fromEntries(LANGUAGES.map((l) => [l, bundle.localizations[l].contentSha256])) };
      }
    }
    if (!pointerMatches(bundle.expected.previewVersion, pointers?.preview_version ?? null)
        || !pointerMatches(bundle.expected.approvedVersion, pointers?.approved_version ?? null)) {
      throw new EditorialPublishError("article publication pointers changed; rebuild the package against the current versions");
    }

    const articleRows = await client.query("SELECT withdrawn_at FROM editorial.articles WHERE article_id = $1", [bundle.articleId]);
    if (!articleRows.rows.length) {
      if (bundle.expected.previewVersion !== null || bundle.expected.approvedVersion !== null) {
        throw new EditorialPublishError("expected pointers do not match a new article");
      }
      await client.query("INSERT INTO editorial.articles(article_id) VALUES ($1)", [bundle.articleId]);
    } else if (articleRows.rows[0].withdrawn_at) {
      throw new EditorialPublishError("withdrawn articles cannot receive a new preview");
    }

    const maxRows = await client.query("SELECT COALESCE(max(version), 0)::int AS version FROM editorial.versions WHERE article_id = $1", [bundle.articleId]);
    const version = maxRows.rows[0].version + 1;
    await client.query(
      "INSERT INTO editorial.versions(article_id, version, source_cutoff, created_by) VALUES ($1, $2, $3, $4)",
      [bundle.articleId, version, bundle.sourceCutoff, bundle.createdBy],
    );
    for (const language of LANGUAGES) {
      const item = bundle.localizations[language];
      await client.query(
        `INSERT INTO editorial.localizations(article_id, version, language, title, summary, body_markdown, content_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [bundle.articleId, version, language, item.title, item.summary, item.body, item.contentSha256],
      );
    }
    if (pointers) {
      await client.query(
        "UPDATE editorial.publications SET preview_version = $2, updated_at = now() WHERE article_id = $1",
        [bundle.articleId, version],
      );
    } else {
      await client.query(
        "INSERT INTO editorial.publications(article_id, preview_version) VALUES ($1, $2)",
        [bundle.articleId, version],
      );
    }
    await client.query(
      "INSERT INTO editorial.publication_history(article_id, version, action) VALUES ($1, $2, 'preview')",
      [bundle.articleId, version],
    );
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
    return { created: true, articleId: bundle.articleId, version,
      approvedVersion: pointers?.approved_version ?? null,
      contentSha256: Object.fromEntries(LANGUAGES.map((l) => [l, bundle.localizations[l].contentSha256])) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export function localEditorialDatabaseUrl() {
  let stat;
  try {
    stat = lstatSync(PASSWORD_PATH);
  } catch {
    throw new EditorialPublishError("local PostgreSQL credentials are missing; set up the local data database first");
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new EditorialPublishError("local PostgreSQL password file must be a regular private file (mode 0600)");
  }
  const password = readFileSync(PASSWORD_PATH, "utf8").trim();
  if (!password) throw new EditorialPublishError("local PostgreSQL password file is empty");
  return `postgresql://openaiwill:${encodeURIComponent(password)}@127.0.0.1:7543/openaiwill_local?application_name=surviagi-editorial-publisher`;
}

function localWriterClient() {
  return new Client({ connectionString: localEditorialDatabaseUrl(), connectionTimeoutMillis: 3000 });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: pnpm editorial:publish --manifest <private-manifest.json> --confirm-public-preview");
    return 0;
  }
  let manifestPath;
  let confirmed = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manifest" && argv[index + 1]) manifestPath = argv[++index];
    else if (argv[index] === "--confirm-public-preview") confirmed = true;
    else throw new EditorialPublishError(`unknown or incomplete option: ${argv[index]}`);
  }
  if (!manifestPath) throw new EditorialPublishError("--manifest is required");
  if (!confirmed) throw new EditorialPublishError("explicit --confirm-public-preview is required; previews are public and not in the regular article list");
  const bundle = loadEditorialPackage(resolve(ROOT, manifestPath));
  const client = localWriterClient();
  try {
    await client.connect();
    const result = await publishEditorialPreview(client, bundle);
    console.log(JSON.stringify({ ...result, previewPath: `/articles/previews/${result.articleId}/v${result.version}` }, null, 2));
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`editorial publish failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
