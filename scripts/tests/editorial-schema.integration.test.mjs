import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import test from 'node:test';
import { startServer, stop } from './site-server.mjs';

const databaseUrl = process.env.EDITORIAL_TEST_DATABASE_URL;

test('editorial schema enforces immutable bilingual public versions and isolated read access', {
  skip: !databaseUrl,
}, async () => {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const editorial = await readFile(new URL('../../db/published/002_editorial.sql', import.meta.url), 'utf8');
    const grants = await readFile(new URL('../../deploy/db/grants.sql', import.meta.url), 'utf8');
    await admin.query("CREATE ROLE oaw_kg_writer LOGIN PASSWORD 'writer-pass'; CREATE ROLE oaw_site LOGIN PASSWORD 'site-pass'; CREATE ROLE oaw_app LOGIN PASSWORD 'app-pass'; CREATE SCHEMA kg AUTHORIZATION oaw_kg_writer");
    const runPsql = async (text) => {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', databaseUrl], { input: text, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    await runPsql(editorial);
    await runPsql(grants);
    await runPsql(editorial);
    await runPsql(grants);

    await admin.query("INSERT INTO editorial.articles(article_id) VALUES ('integration-test')");
    await admin.query("INSERT INTO editorial.versions(article_id, version, source_cutoff, created_by) VALUES ('integration-test', 1, now(), 'test')");
    await admin.query("INSERT INTO editorial.localizations VALUES ('integration-test', 1, 'en', 'Title', 'Summary', 'Body', repeat('a', 64))");
    await admin.query('BEGIN');
    await admin.query("INSERT INTO editorial.publications(article_id, preview_version) VALUES ('integration-test', 1)");
    await assert.rejects(admin.query('COMMIT'), /must include en and zh-CN/);
    await admin.query('ROLLBACK');
    await admin.query("INSERT INTO editorial.localizations VALUES ('integration-test', 1, 'zh-CN', '标题', '摘要', '正文', repeat('b', 64))");
    await admin.query("INSERT INTO editorial.publications(article_id, preview_version, approved_version) VALUES ('integration-test', 1, 1)");
    await admin.query("INSERT INTO editorial.versions(article_id, version, source_cutoff, created_by) VALUES ('integration-test', 2, now(), 'test')");
    await admin.query(
      "INSERT INTO editorial.localizations VALUES ('integration-test', 2, 'en', 'Title 2', 'Summary 2', $1, repeat('c', 64))",
      ['Body 2\n\n| Check | Result |\n| --- | --- |\n| table render | works |'],
    );
    await admin.query('BEGIN');
    await admin.query("UPDATE editorial.publications SET preview_version = 2 WHERE article_id = 'integration-test'");
    await assert.rejects(admin.query('COMMIT'), /must include en and zh-CN/);
    await admin.query('ROLLBACK');
    await admin.query("INSERT INTO editorial.localizations VALUES ('integration-test', 2, 'zh-CN', '标题二', '摘要二', '正文二', repeat('d', 64))");
    await admin.query("UPDATE editorial.publications SET preview_version = 2 WHERE article_id = 'integration-test'");
    const pointers = await admin.query("SELECT preview_version, approved_version FROM editorial.publications WHERE article_id = 'integration-test'");
    assert.deepEqual(pointers.rows[0], { preview_version: 2, approved_version: 1 });
    await admin.query("UPDATE editorial.publications SET preview_version = NULL WHERE article_id = 'integration-test'");
    const cleared = await admin.query("SELECT preview_version, approved_version FROM editorial.publications WHERE article_id = 'integration-test'");
    assert.deepEqual(cleared.rows[0], { preview_version: null, approved_version: 1 });
    await assert.rejects(
      admin.query("UPDATE editorial.localizations SET title = 'rewritten' WHERE article_id = 'integration-test' AND version = 1 AND language = 'en'"),
      /immutable/,
    );

    const withCredentials = (role, password) => databaseUrl.replace(/(postgres(?:ql)?:\/\/)[^@]+@/, `$1${role}:${password}@`);
    const site = new Client({ connectionString: withCredentials('oaw_site', 'site-pass') });
    const app = new Client({ connectionString: withCredentials('oaw_app', 'app-pass') });
    await Promise.all([site.connect(), app.connect()]);
    try {
      await site.query('SELECT * FROM editorial.publications');
      await assert.rejects(site.query("UPDATE editorial.publications SET preview_version = 1 WHERE article_id = 'integration-test'"), /permission denied/);
      await assert.rejects(app.query('SELECT * FROM editorial.publications'), /permission denied/);
    } finally {
      await Promise.all([site.end(), app.end()]);
    }

    await admin.query("CREATE TABLE kg.active(seq bigint, release_id text, manifest jsonb)");
    await admin.query("GRANT USAGE ON SCHEMA kg TO oaw_site; GRANT SELECT ON kg.active TO oaw_site");
    await admin.query("UPDATE editorial.publications SET preview_version = 2 WHERE article_id = 'integration-test'");
    const { base, proc } = await startServer({ DATABASE_URL: withCredentials('oaw_site', 'site-pass') });
    try {
      const previewPath = '/articles/previews/integration-test/v2';
      const english = await fetch(`${base}${previewPath}`);
      assert.equal(english.status, 200);
      const englishHtml = await english.text();
      assert.match(englishHtml, /Title 2/);
      assert.match(englishHtml, /PUBLIC PREPRINT · NOT APPROVED/);
      assert.doesNotMatch(englishHtml, /name="robots" content="noindex/);
      assert.match(englishHtml, /Evidence cutoff/);
      assert.match(englishHtml, /Body 2/);
      assert.match(englishHtml, /table render/);
      assert.match(englishHtml, /<th[^>]*>[\s\S]*?Check[\s\S]*?<\/th>/);

      const chinese = await fetch(`${base}/zh-CN${previewPath}`);
      assert.equal(chinese.status, 200);
      const chineseHtml = await chinese.text();
      assert.match(chineseHtml, /标题二/);
      assert.match(chineseHtml, /公开预发布 · 尚未批准/);
      assert.match(chineseHtml, /正文二/);

      const markdown = await fetch(`${base}${previewPath}/raw.md`);
      assert.equal(markdown.status, 200);
      assert.match(markdown.headers.get('content-type'), /text\/markdown/);
      assert.equal(markdown.headers.get('cache-control'), 'no-store');
      assert.match(markdown.headers.get('link'), /rel="canonical"/);
      assert.match(await markdown.text(), /PUBLIC PREPRINT · NOT APPROVED.*Version 2/s);

      const directory = await fetch(`${base}/articles/previews`);
      assert.equal(directory.status, 200);
      assert.match(await directory.text(), /integration-test\/v2/);
      const regular = await fetch(`${base}/articles`);
      assert.equal(regular.status, 200);
      assert.doesNotMatch(await regular.text(), /integration-test|PUBLIC PREPRINT/);
      const sitemap = await fetch(`${base}/sitemap.xml`);
      assert.equal(sitemap.status, 200);
      assert.match(await sitemap.text(), /articles\/previews\/integration-test\/v2/);

      const approved = await fetch(`${base}/articles/previews/integration-test/v1`);
      assert.equal(approved.status, 200);
      assert.match(await approved.text(), /APPROVED VERSION/);
      assert.equal((await fetch(`${base}/articles/previews/integration-test/v3`)).status, 404);
      await admin.query("UPDATE editorial.articles SET withdrawn_at = now(), withdrawal_reason = 'integration test' WHERE article_id = 'integration-test'");
      assert.equal((await fetch(`${base}${previewPath}`)).status, 404);
      assert.equal((await fetch(`${base}${previewPath}/raw.md`)).status, 404);
      const withdrawnSitemap = await (await fetch(`${base}/sitemap.xml`)).text();
      assert.doesNotMatch(withdrawnSitemap, /articles\/previews\/integration-test\/v2/);
    } finally {
      await stop(proc);
    }
  } finally {
    await admin.end();
  }
});
