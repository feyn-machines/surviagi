import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import test from 'node:test';
import { freePort, startServer, stop } from './site-server.mjs';

const databaseUrl = process.env.EDITORIAL_TEST_DATABASE_URL;

test('editorial schema enforces immutable bilingual public versions and isolated read access', {
  skip: !databaseUrl,
}, async () => {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const editorial = await readFile(new URL('../../db/published/002_editorial.sql', import.meta.url), 'utf8');
    const appCore = await readFile(new URL('../../db/app/001_app.sql', import.meta.url), 'utf8');
    const appAgent = await readFile(new URL('../../db/app/002_agent_access.sql', import.meta.url), 'utf8');
    const editorialReview = await readFile(new URL('../../db/app/003_editorial_review.sql', import.meta.url), 'utf8');
    const grants = await readFile(new URL('../../deploy/db/grants.sql', import.meta.url), 'utf8');
    await admin.query("CREATE ROLE oaw_kg_writer LOGIN PASSWORD 'writer-pass'; CREATE ROLE oaw_site LOGIN PASSWORD 'site-pass'; CREATE ROLE oaw_app LOGIN PASSWORD 'app-pass'; ALTER ROLE oaw_app SET search_path = app; CREATE SCHEMA kg AUTHORIZATION oaw_kg_writer; CREATE SCHEMA app AUTHORIZATION oaw_app");
    const withCredentials = (role, password) => databaseUrl.replace(/(postgres(?:ql)?:\/\/)[^@]+@/, `$1${role}:${password}@`);
    const runPsql = async (text, connectionString = databaseUrl) => {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', connectionString], { input: text, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    await runPsql(editorial);
    await runPsql(grants);
    await runPsql(appCore, withCredentials('oaw_app', 'app-pass'));
    await runPsql(appAgent, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialReview, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialReview, withCredentials('oaw_app', 'app-pass'));
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

    const site = new Client({ connectionString: withCredentials('oaw_site', 'site-pass') });
    const app = new Client({ connectionString: withCredentials('oaw_app', 'app-pass') });
    const writer = new Client({ connectionString: withCredentials('oaw_kg_writer', 'writer-pass') });
    await Promise.all([site.connect(), app.connect(), writer.connect()]);
    try {
      await site.query('SELECT * FROM editorial.publications');
      await assert.rejects(site.query("UPDATE editorial.publications SET preview_version = 1 WHERE article_id = 'integration-test'"), /permission denied/);
      await assert.rejects(app.query('SELECT * FROM editorial.publications'), /permission denied/);
      await assert.rejects(site.query('SELECT * FROM app.editorial_reviews'), /permission denied/);
      await assert.rejects(writer.query('SELECT * FROM app.editorial_reviews'), /permission denied/);

      const review = await app.query(
        `INSERT INTO app.editorial_reviews
          (article_id, version, language, content_sha256, review_scope, decision, actor_kind, actor_id, note)
         VALUES ('integration-test', 1, 'en', repeat('a', 64), 'readability', 'approve', 'human', 'user:test', 'Readable for the intended audience')
         RETURNING review_id`,
      );
      const reviewId = review.rows[0].review_id;
      assert.equal((await app.query('SELECT review_scope, decision, actor_kind FROM app.editorial_reviews WHERE review_id = $1', [reviewId])).rows[0].review_scope, 'readability');
      await app.query(
        `INSERT INTO app.editorial_review_annotations (review_id, paragraph_key, selected_text, context_before, context_after, comment)
         VALUES ($1, 'p:3:abc', 'Selected sentence', 'Before', 'After', 'Clarify the comparison')`,
        [reviewId],
      );
      const edit = await app.query(
        `INSERT INTO app.editorial_review_edits (review_id, before_markdown, after_markdown, unified_diff)
         VALUES ($1, 'Old sentence.', 'Revised sentence.', '-Old sentence.\n+Revised sentence.') RETURNING edit_id`,
        [reviewId],
      );
      await app.query(
        `INSERT INTO app.editorial_feedback_applications
          (source_review_id, source_edit_id, article_id, applied_version, language, applied_content_sha256, application_note, actor_id)
         VALUES ($1, $2, 'integration-test', 2, 'en', repeat('c', 64), 'Applied the requested readability change', 'user:test')`,
        [reviewId, edit.rows[0].edit_id],
      );
      await assert.rejects(
        app.query(
          `INSERT INTO app.editorial_feedback_applications
            (source_review_id, source_edit_id, article_id, applied_version, language, applied_content_sha256, application_note, actor_id)
           VALUES ($1, $2, 'integration-test', 1, 'en', repeat('a', 64), 'Cannot apply to the same version', 'user:test')`,
          [reviewId, edit.rows[0].edit_id],
        ),
        /later version/,
      );
      await assert.rejects(
        app.query(
          `INSERT INTO app.editorial_feedback_applications
            (source_review_id, source_edit_id, article_id, applied_version, language, applied_content_sha256, application_note, actor_id)
           VALUES ($1, $2, 'integration-test', 2, 'zh-CN', repeat('d', 64), 'Cannot apply English feedback to Chinese', 'user:test')`,
          [reviewId, edit.rows[0].edit_id],
        ),
        /later version/,
      );
      assert.equal((await app.query('SELECT count(*)::int AS count FROM app.editorial_review_annotations')).rows[0].count, 1);
      assert.equal((await app.query('SELECT applied_version FROM app.editorial_feedback_applications')).rows[0].applied_version, 2);
      await assert.rejects(app.query("UPDATE app.editorial_reviews SET note = 'rewritten' WHERE review_id = $1", [reviewId]), /append-only/);
      await assert.rejects(app.query('DELETE FROM app.editorial_review_edits WHERE edit_id = $1', [edit.rows[0].edit_id]), /append-only/);
    } finally {
      await Promise.all([site.end(), app.end(), writer.end()]);
    }

    await admin.query("CREATE TABLE kg.active(seq bigint, release_id text, manifest jsonb)");
    await admin.query("GRANT USAGE ON SCHEMA kg TO oaw_site; GRANT SELECT ON kg.active TO oaw_site");
    await admin.query("UPDATE editorial.publications SET preview_version = 2 WHERE article_id = 'integration-test'");
    const appSecret = 'editorial-review-integration-secret';
    const adminToken = 'review-admin-token';
    const readerToken = 'review-reader-token';
    const appDb = new Client({ connectionString: withCredentials('oaw_app', 'app-pass') });
    await appDb.connect();
    try {
      await appDb.query('INSERT INTO app."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true), ($4, $5, $6, true)', ['review-admin', 'Review Admin', 'review-admin@example.test', 'review-reader', 'Review Reader', 'review-reader@example.test']);
      await appDb.query('INSERT INTO app.admins (email) VALUES ($1)', ['review-admin@example.test']);
      await appDb.query('INSERT INTO app.session (id, "expiresAt", token, "updatedAt", "userId") VALUES ($1, now() + interval \'1 day\', $2, now(), $3), ($4, now() + interval \'1 day\', $5, now(), $6)', ['s-review-admin', adminToken, 'review-admin', 's-review-reader', readerToken, 'review-reader']);
    } finally {
      await appDb.end();
    }
    const authCookie = (token) => `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', appSecret).update(token).digest('base64')}`)}`;
    const port = await freePort();
    const baseURL = `http://127.0.0.1:${port}`;
    const { base, proc } = await startServer({
      DATABASE_URL: withCredentials('oaw_site', 'site-pass'),
      APP_DATABASE_URL: withCredentials('oaw_app', 'app-pass'),
      BETTER_AUTH_SECRET: appSecret,
      BETTER_AUTH_URL: baseURL,
      GOOGLE_CLIENT_ID: 'dummy-id',
      GOOGLE_CLIENT_SECRET: 'dummy-secret',
    }, port);
    try {
      const reviewUrl = `${base}/api/admin/editorial?articleId=integration-test&version=2&language=en`;
      assert.equal((await fetch(reviewUrl)).status, 404);
      assert.equal((await fetch(reviewUrl, { headers: { cookie: authCookie(readerToken) } })).status, 404);
      const headers = { cookie: authCookie(adminToken), origin: base, 'content-type': 'application/json' };
      assert.equal((await fetch(`${base}/admin/editorial`)).status, 404);
      assert.equal((await fetch(`${base}/admin/editorial`, { headers: { cookie: authCookie(readerToken) } })).status, 404);
      const adminQueue = await fetch(`${base}/admin/editorial`, { headers: { cookie: authCookie(adminToken) } });
      assert.equal(adminQueue.status, 200);
      const adminQueueHtml = await adminQueue.text();
      assert.match(adminQueueHtml, /Article review/);
      assert.match(adminQueueHtml, /Title 2/);
      assert.match(adminQueueHtml, /标题二/);
      assert.match(adminQueueHtml, /Review both languages/);
      const selectedReview = await fetch(`${base}/admin/editorial?articleId=integration-test&version=v2`, { headers: { cookie: authCookie(adminToken) } });
      assert.equal(selectedReview.status, 200);
      const selectedHtml = await selectedReview.text();
      assert.match(selectedHtml, /Review version(?:\s|<!-- -->)*2/);
      const chineseQueue = await fetch(`${base}/zh-CN/admin/editorial`, { headers: { cookie: authCookie(adminToken) } });
      assert.equal(chineseQueue.status, 200);
      assert.match(await chineseQueue.text(), /文章审核/);

      const initialReview = await fetch(reviewUrl, { headers });
      assert.equal(initialReview.status, 200);
      assert.equal(initialReview.headers.get('cache-control'), 'no-store');
      assert.equal(initialReview.headers.get('x-robots-tag'), 'noindex');
      const initial = await initialReview.json();
      assert.equal(initial.article.contentSha256, 'c'.repeat(64));
      assert.deepEqual(initial.reviews, []);

      const reviewBody = {
        articleId: 'integration-test', version: 2, language: 'en', contentSha256: 'c'.repeat(64),
        reviewScope: 'readability', decision: 'request_revision', note: 'Explain the limitation earlier.',
        annotations: [{ paragraphKey: 'p:1:example', selectedText: ' Body 2 ', contextBefore: ' before ', contextAfter: ' after ', comment: 'Name the comparison group.' }],
        edit: { afterMarkdown: 'Revised Body 2' },
      };
      const wrongOrigin = await fetch(`${base}/api/admin/editorial`, { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body: JSON.stringify(reviewBody) });
      assert.equal(wrongOrigin.status, 403);
      const staleHash = await fetch(`${base}/api/admin/editorial`, { method: 'POST', headers, body: JSON.stringify({ ...reviewBody, contentSha256: '0'.repeat(64) }) });
      assert.equal(staleHash.status, 409);
      const recorded = await fetch(`${base}/api/admin/editorial`, { method: 'POST', headers, body: JSON.stringify(reviewBody) });
      assert.equal(recorded.status, 200);
      assert.equal((await recorded.json()).publicationChanged, false);
      const reviewed = await (await fetch(reviewUrl, { headers: { cookie: authCookie(adminToken) } })).json();
      assert.equal(reviewed.reviews[0].review_scope, 'readability');
      assert.equal(reviewed.reviews[0].decision, 'request_revision');
      assert.equal(reviewed.annotations[0].paragraph_key, 'p:1:example');
      assert.equal(reviewed.annotations[0].selected_text, ' Body 2 ');
      assert.equal(reviewed.annotations[0].context_before, ' before ');
      assert.equal(reviewed.edits[0].before_markdown.includes('Body 2'), true);
      assert.equal(reviewed.edits[0].after_markdown, 'Revised Body 2');

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
