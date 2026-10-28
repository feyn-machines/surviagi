import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import test from 'node:test';
import { freePort, startServer, stop } from './site-server.mjs';
import { EditorialPublishError, publishEditorialPreview } from '../editorial-publish.mjs';

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
    const editorialPublicationScope = await readFile(new URL('../../db/app/004_editorial_publication_scope.sql', import.meta.url), 'utf8');
    const editorialFeedbackSamples = await readFile(new URL('../../db/app/005_editorial_feedback_samples.sql', import.meta.url), 'utf8');
    const editorialFeedbackApplications = await readFile(new URL('../../db/app/006_editorial_feedback_sample_applications.sql', import.meta.url), 'utf8');
    const editorialApprovalBatches = await readFile(new URL('../../db/app/007_editorial_approval_batches.sql', import.meta.url), 'utf8');
    const editorialLanguageApprovalBatches = await readFile(new URL('../../db/app/008_editorial_language_approval_batches.sql', import.meta.url), 'utf8');
    const editorialApproval = await readFile(new URL('../../db/published/003_editorial_approval.sql', import.meta.url), 'utf8');
    const editorialWithdrawal = await readFile(new URL('../../db/published/004_editorial_withdrawal.sql', import.meta.url), 'utf8');
    const grants = await readFile(new URL('../../deploy/db/grants.sql', import.meta.url), 'utf8');
    await admin.query("CREATE ROLE oaw_kg_writer LOGIN PASSWORD 'writer-pass'; CREATE ROLE oaw_site LOGIN PASSWORD 'site-pass'; CREATE ROLE oaw_app LOGIN PASSWORD 'app-pass'; ALTER ROLE oaw_app SET search_path = app; CREATE SCHEMA kg AUTHORIZATION oaw_kg_writer; CREATE SCHEMA app AUTHORIZATION oaw_app");
    await admin.query('GRANT CONNECT, CREATE ON DATABASE postgres TO oaw_kg_writer');
    const withCredentials = (role, password) => databaseUrl.replace(/(postgres(?:ql)?:\/\/)[^@]+@/, `$1${role}:${password}@`);
    const runPsql = async (text, connectionString = databaseUrl) => {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', connectionString], { input: text, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    await runPsql(editorial, withCredentials('oaw_kg_writer', 'writer-pass'));
    await runPsql(grants, withCredentials('oaw_kg_writer', 'writer-pass'));
    await runPsql(appCore, withCredentials('oaw_app', 'app-pass'));
    await runPsql(appAgent, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialReview, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialReview, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialPublicationScope, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialPublicationScope, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialFeedbackSamples, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialFeedbackSamples, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialFeedbackApplications, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialFeedbackApplications, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialApprovalBatches, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialApprovalBatches, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialLanguageApprovalBatches, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorialLanguageApprovalBatches, withCredentials('oaw_app', 'app-pass'));
    await runPsql(editorial, withCredentials('oaw_kg_writer', 'writer-pass'));
    await runPsql(grants, withCredentials('oaw_kg_writer', 'writer-pass'));
    await runPsql(editorialApproval);
    await runPsql(editorialApproval);
    await runPsql(editorialWithdrawal);
    await runPsql(editorialWithdrawal);

    await admin.query("INSERT INTO editorial.articles(article_id) VALUES ('integration-test')");
    await admin.query("INSERT INTO editorial.versions(article_id, version, source_cutoff, created_by) VALUES ('integration-test', 1, now(), 'test')");
    await admin.query("INSERT INTO editorial.localizations VALUES ('integration-test', 1, 'en', 'Integration robotics automation report', 'Public approved article about integration robotics automation.', 'Article body with a source [Official report](https://example.test/source).', repeat('a', 64))");
    await admin.query('BEGIN');
    await admin.query("INSERT INTO editorial.publications(article_id, preview_version) VALUES ('integration-test', 1)");
    await assert.rejects(admin.query('COMMIT'), /must include en and zh-CN/);
    await admin.query('ROLLBACK');
    await admin.query("INSERT INTO editorial.localizations VALUES ('integration-test', 1, 'zh-CN', '集成机器人自动化报告', '关于集成机器人自动化的公开批准文章。', '文章正文及来源 [官方报告](https://example.test/source-zh)。', repeat('b', 64))");
    await admin.query("INSERT INTO editorial.publications(article_id, preview_version, approved_version) VALUES ('integration-test', 1, 1)");
    await admin.query("INSERT INTO editorial.publication_history(article_id, version, action) VALUES ('integration-test', 1, 'approve')");
    await admin.query("INSERT INTO editorial.versions(article_id, version, source_cutoff, created_by) VALUES ('integration-test', 2, now(), 'test')");
    await admin.query(
      "INSERT INTO editorial.localizations VALUES ('integration-test', 2, 'en', 'Integration robotics automation preview', 'Public preview about integration robotics automation.', $1, repeat('c', 64))",
      ['Body 2: Preview full text with a source [Public source](https://example.test/preview-source).\n\n| Check | Result |\n| --- | --- |\n| table render | works |'],
    );
    await admin.query('BEGIN');
    await admin.query("UPDATE editorial.publications SET preview_version = 2 WHERE article_id = 'integration-test'");
    await assert.rejects(admin.query('COMMIT'), /must include en and zh-CN/);
    await admin.query('ROLLBACK');
    await admin.query("INSERT INTO editorial.localizations VALUES ('integration-test', 2, 'zh-CN', '集成机器人自动化预发布', '关于集成机器人自动化的公开预发布文章。', '预发布全文及来源 [公开来源](https://example.test/preview-source-zh)。', repeat('d', 64))");
    await admin.query("UPDATE editorial.publications SET preview_version = 2 WHERE article_id = 'integration-test'");
    await admin.query("INSERT INTO editorial.publication_history(article_id, version, action) VALUES ('integration-test', 2, 'preview')");
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
      assert.equal((await admin.query("SELECT tableowner FROM pg_tables WHERE schemaname = 'editorial' AND tablename = 'localizations'")).rows[0].tableowner, 'oaw_kg_writer');
      assert.equal((await writer.query("SELECT count(*)::int AS count FROM editorial.localizations")).rows[0].count, 4);
      assert.equal((await admin.query("SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'approve_public_preview'")).rows[0].owner, 'oaw_kg_writer');
      assert.equal((await admin.query("SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'withdraw_public_article'")).rows[0].owner, 'oaw_kg_writer');
      await site.query('SELECT * FROM editorial.publications');
      await assert.rejects(site.query("UPDATE editorial.publications SET preview_version = 1 WHERE article_id = 'integration-test'"), /permission denied/);
      await assert.rejects(app.query('SELECT * FROM editorial.publications'), /permission denied/);
      await assert.rejects(site.query('SELECT * FROM app.editorial_reviews'), /permission denied/);
      await assert.rejects(site.query('SELECT * FROM app.editorial_feedback_samples'), /permission denied/);
      await assert.rejects(site.query('SELECT * FROM app.editorial_feedback_sample_applications'), /permission denied/);
      await assert.rejects(site.query('SELECT * FROM app.editorial_approval_batches'), /permission denied/);
      await assert.rejects(writer.query('SELECT * FROM app.editorial_approval_batch_items'), /permission denied/);
      await assert.rejects(writer.query('SELECT * FROM app.editorial_reviews'), /permission denied/);
      await assert.rejects(site.query('SELECT * FROM editorial.review_approval_evidence'), /permission denied/);
      await assert.rejects(app.query('SELECT * FROM editorial.review_approval_evidence'), /permission denied/);
      await assert.rejects(site.query("SELECT editorial.approve_public_preview('integration-test', 2, repeat('c', 64), repeat('d', 64))"), /permission denied/);
      await assert.rejects(site.query("SELECT editorial.withdraw_public_article('integration-test', 2, 1, 'This reason is long enough for test')"), /permission denied/);
      await assert.rejects(app.query("UPDATE editorial.publications SET approved_version = 2 WHERE article_id = 'integration-test'"), /permission denied/);
      await assert.rejects(app.query("SELECT editorial.approve_public_preview('integration-test', 2, repeat('c', 64), repeat('d', 64))"), (error) => error.code === '40001');
      assert.equal((await admin.query("SELECT has_schema_privilege('oaw_app', 'editorial', 'CREATE') AS can_create")).rows[0].can_create, false);

      const bodyHash = (body) => createHash('sha256').update(body, 'utf8').digest('hex');
      const makeBundle = (version, enBody, zhBody) => ({
        articleId: 'publisher-integration',
        sourceCutoff: '2026-10-28T00:00:00Z',
        createdBy: 'editorial-run:0123456789abcdef01234567',
        expected: { previewVersion: version, approvedVersion: version === null ? null : 1 },
        localizations: {
          en: { title: `Publisher integration v${version ?? 1}`, summary: 'English publish fixture', body: enBody, contentSha256: bodyHash(enBody) },
          'zh-CN': { title: `发布集成测试 v${version ?? 1}`, summary: '中文发布测试', body: zhBody, contentSha256: bodyHash(zhBody) },
        },
      });
      const bodyV1 = '[source](https://example.test/publisher-v1)';
      const firstBundle = makeBundle(null, bodyV1, bodyV1);
      const firstPublish = await publishEditorialPreview(writer, firstBundle);
      assert.deepEqual({ created: firstPublish.created, version: firstPublish.version, approved: firstPublish.approvedVersion },
        { created: true, version: 1, approved: null });
      const retryPublish = await publishEditorialPreview(writer, firstBundle);
      assert.equal(retryPublish.created, false);
      assert.equal(retryPublish.version, 1);
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM editorial.publication_history WHERE article_id = 'publisher-integration' AND action = 'preview'")).rows[0].count, 1);

      await admin.query("UPDATE editorial.publications SET approved_version = 1 WHERE article_id = 'publisher-integration'");
      const bodyV2 = '[source](https://example.test/publisher-v2)';
      const secondPublish = await publishEditorialPreview(writer, makeBundle(1, bodyV2, bodyV2));
      assert.deepEqual({ created: secondPublish.created, version: secondPublish.version, approved: secondPublish.approvedVersion },
        { created: true, version: 2, approved: 1 });
      await assert.rejects(publishEditorialPreview(writer, makeBundle(1, `${bodyV2} stale`, `${bodyV2} stale`)),
        EditorialPublishError);
      assert.deepEqual((await admin.query("SELECT preview_version, approved_version FROM editorial.publications WHERE article_id = 'publisher-integration'")).rows[0],
        { preview_version: 2, approved_version: 1 });

      const review = await app.query(
        `INSERT INTO app.editorial_reviews
          (article_id, version, language, content_sha256, review_scope, decision, actor_kind, actor_id, note)
         VALUES ('integration-test', 1, 'en', repeat('a', 64), 'readability', 'approve', 'human', 'user:test', 'Readable for the intended audience')
         RETURNING review_id`,
      );
      const reviewId = review.rows[0].review_id;
      assert.equal((await writer.query("SELECT decision FROM editorial.review_approval_evidence WHERE article_id = 'integration-test' AND version = 1 AND language = 'en'")).rows[0].decision, 'approve');
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
      assert.equal((await app.query("SELECT review_scope FROM app.editorial_reviews WHERE review_scope = 'publication' ")).rows.length, 0);
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
    const { base, proc, log } = await startServer({
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
      const approveUrl = `${base}/api/admin/editorial/approve`;
      const batchUrl = `${base}/api/admin/editorial/approve-batch`;
      const withdrawalUrl = `${base}/api/admin/editorial/withdraw`;
      const approveBody = { articleId: 'integration-test', version: 2, contentSha256: { en: 'c'.repeat(64), 'zh-CN': 'd'.repeat(64) } };
      assert.equal((await fetch(approveUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(approveBody) })).status, 404);
      assert.equal((await fetch(approveUrl, { method: 'POST', headers: { cookie: authCookie(readerToken), origin: base, 'content-type': 'application/json' }, body: JSON.stringify(approveBody) })).status, 404);
      assert.equal((await fetch(approveUrl, { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body: JSON.stringify(approveBody) })).status, 403);
      assert.equal((await fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify({ ...approveBody, contentSha256: { en: '0'.repeat(64), 'zh-CN': 'd'.repeat(64) } }) })).status, 409);
      assert.equal((await fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify({ articleId: 'integration-test', version: 1, contentSha256: { en: 'a'.repeat(64), 'zh-CN': 'b'.repeat(64) } }) })).status, 409);
      const missingLanguageApproval = await fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify(approveBody) });
      assert.equal(missingLanguageApproval.status, 422);
      const invalidBatch = await fetch(batchUrl, { method: 'POST', headers, body: JSON.stringify({ batchId: 'bad', items: [approveBody] }) });
      assert.equal(invalidBatch.status, 400);
      assert.equal((await fetch(batchUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
      assert.equal((await fetch(batchUrl, { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body: JSON.stringify({ batchId: 'b54a5f47-120b-4b6d-8c08-49c2eea9d611', items: [approveBody] }) })).status, 403);
      const isolatedBatch = {
        batchId: 'b54a5f47-120b-4b6d-8c08-49c2eea9d611',
        items: [
          { articleId: 'integration-test', version: 1, language: 'en', contentSha256: { en: 'a'.repeat(64), 'zh-CN': 'b'.repeat(64) } },
          { ...approveBody, language: 'en' },
        ],
      };
      const isolatedResponse = await fetch(batchUrl, { method: 'POST', headers, body: JSON.stringify(isolatedBatch) });
      assert.equal(isolatedResponse.status, 200, `${await isolatedResponse.clone().text()}\n${log()}`);
      const isolatedResult = await isolatedResponse.json();
      assert.deepEqual(isolatedResult.results.map(({ status }) => status), ['already_approved', 'language_approved']);
      const isolatedRetry = await fetch(batchUrl, { method: 'POST', headers, body: JSON.stringify(isolatedBatch) });
      assert.equal(isolatedRetry.status, 200);
      assert.equal((await isolatedRetry.json()).replayed, true);
      assert.equal((await fetch(batchUrl, { method: 'POST', headers, body: JSON.stringify({ ...isolatedBatch, items: [{ ...approveBody, language: 'zh-CN' }] }) })).status, 409);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM app.editorial_approval_batch_items WHERE batch_id = $1', [isolatedBatch.batchId])).rows[0].count, 2);
      assert.equal((await admin.query('SELECT language FROM app.editorial_approval_batch_items WHERE batch_id = $1 AND item_index = 1', [isolatedBatch.batchId])).rows[0].language, 'en');
      assert.equal((await fetch(`${base}/admin/editorial`)).status, 404);
      assert.equal((await fetch(`${base}/admin/editorial`, { headers: { cookie: authCookie(readerToken) } })).status, 404);
      const adminQueue = await fetch(`${base}/admin/editorial`, { headers: { cookie: authCookie(adminToken) } });
      assert.equal(adminQueue.status, 200);
      const adminQueueHtml = (await adminQueue.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
      assert.match(adminQueueHtml, /Article review/);
      assert.doesNotMatch(adminQueueHtml, /articleId=integration-test&amp;version=v2&amp;reviewLanguage=en/, "approved English draft is no longer a pending task");
      assert.doesNotMatch(adminQueueHtml, /Integration robotics automation report/, 'already approved historical versions are not offered for another approval');
      assert.match(adminQueueHtml, /集成机器人自动化预发布/);
      assert.match(adminQueueHtml, /To review/);
      assert.match(adminQueueHtml, /English/);
      assert.match(adminQueueHtml, /Awaiting review/);
      assert.match(adminQueueHtml, /reviewLanguage=zh-CN/);
      const reviewedHtml = await (await fetch(`${base}/admin/editorial?view=reviewed`, { headers })).text();
      assert.match(reviewedHtml, /Review other language/);
      assert.match(reviewedHtml, /reviewLanguage=en/);
      const selectedReview = await fetch(`${base}/admin/editorial?articleId=integration-test&version=v2`, { headers: { cookie: authCookie(adminToken) } });
      assert.equal(selectedReview.status, 200);
      const selectedHtml = await selectedReview.text();
      assert.match(selectedHtml, /Version(?:\s|<!-- -->)*2/);
      const chineseQueue = await fetch(`${base}/zh-CN/admin/editorial`, { headers: { cookie: authCookie(adminToken) } });
      assert.equal(chineseQueue.status, 200);
      assert.match(await chineseQueue.text(), /文章审核/);

      const initialReview = await fetch(reviewUrl, { headers });
      assert.equal(initialReview.status, 200);
      assert.equal(initialReview.headers.get('cache-control'), 'no-store');
      assert.equal(initialReview.headers.get('x-robots-tag'), 'noindex');
      const initial = await initialReview.json();
      assert.equal(initial.article.contentSha256, 'c'.repeat(64));
      assert.equal(initial.reviews.length, 1);
      assert.equal(initial.reviews[0].review_scope, 'publication');
      assert.equal(initial.reviews[0].decision, 'approve');

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
      const revisionRequest = reviewed.reviews.find((row) => row.decision === 'request_revision');
      assert.equal(revisionRequest.review_scope, 'readability');
      assert.equal(reviewed.annotations[0].paragraph_key, 'p:1:example');
      assert.equal(reviewed.annotations[0].selected_text, ' Body 2 ');
      assert.equal(reviewed.annotations[0].context_before, ' before ');
      assert.equal(reviewed.edits[0].before_markdown.includes('Body 2'), true);
      assert.equal(reviewed.edits[0].after_markdown, 'Revised Body 2');

      const samplesUrl = `${base}/api/admin/editorial/feedback-samples`;
      assert.equal((await fetch(`${samplesUrl}?language=en`)).status, 404);
      assert.equal((await fetch(`${samplesUrl}?language=en`, { headers: { cookie: authCookie(readerToken) } })).status, 404);
      const emptySamples = await fetch(`${samplesUrl}?language=en`, { headers });
      assert.equal(emptySamples.status, 200);
      assert.deepEqual((await emptySamples.json()).samples, []);
      const sample = {
        sourceReviewId: revisionRequest.review_id,
        sourceEditId: reviewed.edits[0].edit_id,
        language: 'en', feedbackScope: 'single_article', issueType: 'clarity', articleGenre: 'event_thread',
        problem: 'The opening delays the key caveat.',
        beforeExcerpt: 'Body 2', afterExcerpt: 'Revised Body 2',
        applicability: 'When technical context is needed before interpreting the main claim.',
        preferenceEvidence: null,
      };
      assert.equal((await fetch(samplesUrl, { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body: JSON.stringify(sample) })).status, 403);
      const curatedOneOff = await fetch(samplesUrl, { method: 'POST', headers, body: JSON.stringify(sample) });
      assert.equal(curatedOneOff.status, 201);
      const curatedId = (await curatedOneOff.json()).sampleId;
      assert.equal((await fetch(samplesUrl, { method: 'POST', headers, body: JSON.stringify({ ...sample, issueType: 'specificity', beforeExcerpt: 'fabricated excerpt' }) })).status, 400,
        'curated excerpts must be present in the exact source edit');
      assert.equal((await fetch(samplesUrl, { method: 'POST', headers, body: JSON.stringify(sample) })).status, 409,
        'the same source edit cannot be duplicated for a scope and issue type');
      const articleSamples = await fetch(`${samplesUrl}?language=en&issueType=clarity&articleGenre=event_thread&articleId=integration-test`, { headers });
      assert.equal(articleSamples.headers.get('cache-control'), 'no-store');
      assert.equal(articleSamples.headers.get('x-robots-tag'), 'noindex');
      const articleSampleRows = (await articleSamples.json()).samples;
      assert.equal(articleSampleRows.length, 1);
      assert.equal(articleSampleRows[0].sample_id, curatedId);
      assert.equal(articleSampleRows[0].before_excerpt, 'Body 2');
      assert.equal(articleSampleRows[0].after_excerpt, 'Revised Body 2');
      assert.equal(articleSampleRows[0].source_content_sha256, 'c'.repeat(64));
      assert.deepEqual((await (await fetch(`${samplesUrl}?language=en`, { headers })).json()).samples, [], 'one-off examples are excluded from general writing retrieval');
      assert.deepEqual((await (await fetch(`${samplesUrl}?language=zh-CN&articleId=integration-test`, { headers })).json()).samples, [], 'examples are language-specific');
      assert.deepEqual((await (await fetch(`${samplesUrl}?language=en&articleId=another-article`, { headers })).json()).samples, [], 'one-off examples do not transfer to another article');
      assert.equal((await fetch(samplesUrl, { method: 'POST', headers, body: JSON.stringify({ ...sample, language: 'zh-CN' }) })).status, 404, 'a sample cannot relabel its source language');

      const reusableNote = 'For all event threads, state the practical change before the evidence details.';
      const reusableReviewResponse = await fetch(`${base}/api/admin/editorial`, {
        method: 'POST', headers,
        body: JSON.stringify({ articleId: 'integration-test', version: 2, language: 'en', contentSha256: 'c'.repeat(64),
          reviewScope: 'readability', decision: 'comment', note: reusableNote, edit: { afterMarkdown: 'Start with the practical change, then explain the evidence.' } }),
      });
      assert.equal(reusableReviewResponse.status, 200);
      const reusableDetail = await (await fetch(reviewUrl, { headers })).json();
      const reusableReview = reusableDetail.reviews.find((row) => row.note === reusableNote);
      const reusableEdit = reusableDetail.edits.find((row) => row.review_id === reusableReview.review_id);
      const reusableSample = {
        sourceReviewId: reusableReview.review_id, sourceEditId: reusableEdit.edit_id,
        language: 'en', feedbackScope: 'reusable_preference', issueType: 'structure', articleGenre: 'event_thread',
        problem: 'The reader cannot see the practical change soon enough.',
        beforeExcerpt: 'Body 2', afterExcerpt: 'Start with the practical change, then explain the evidence.',
        applicability: 'When an event thread explains several linked changes before stating their effect.',
        preferenceEvidence: reusableNote,
      };
      assert.equal((await fetch(samplesUrl, { method: 'POST', headers, body: JSON.stringify({ ...reusableSample, preferenceEvidence: 'An invented preference not present in the review.' }) })).status, 400);
      const reusableCreated = await fetch(samplesUrl, { method: 'POST', headers, body: JSON.stringify(reusableSample) });
      assert.equal(reusableCreated.status, 201);
      const reusableSampleId = (await reusableCreated.json()).sampleId;
      const sampleApplicationSql = `INSERT INTO app.editorial_feedback_sample_applications
        (sample_id, article_id, applied_version, language, applied_content_sha256, application_note, actor_id)
        VALUES ($1, $2, $3, $4, repeat('e', 64), 'Used as a style example while drafting', 'editorial-skill')
        ON CONFLICT (sample_id, article_id, applied_version, language) DO NOTHING RETURNING application_id`;
      const oneOffApplication = await admin.query(sampleApplicationSql, [curatedId, 'integration-test', 3, 'en']);
      assert.equal(oneOffApplication.rowCount, 1);
      assert.equal((await admin.query(sampleApplicationSql, [curatedId, 'integration-test', 3, 'en'])).rowCount, 0,
        'the same sample/version use is idempotent');
      await assert.rejects(admin.query(sampleApplicationSql, [curatedId, 'next-article', 1, 'en']), /single-article/);
      await assert.rejects(admin.query(sampleApplicationSql, [curatedId, 'integration-test', 4, 'zh-CN']), /source language/);
      assert.equal((await admin.query(sampleApplicationSql, [reusableSampleId, 'next-article', 1, 'en'])).rowCount, 1,
        'a quoted reusable preference may inform another article');
      await assert.rejects(admin.query(sampleApplicationSql, [reusableSampleId, 'integration-test', 1, 'en']), /later version/);
      const crossArticleSamples = await (await fetch(`${samplesUrl}?language=en&issueType=structure&articleGenre=event_thread&articleId=next-event`, { headers })).json();
      assert.equal(crossArticleSamples.samples.length, 1, 'only explicitly quoted reusable preferences can be retrieved for another article');
      assert.equal(crossArticleSamples.samples[0].preference_evidence, reusableNote);
      for (const issueType of ['clarity', 'specificity', 'tone']) {
        await admin.query(
          `INSERT INTO app.editorial_feedback_samples
            (source_review_id, source_edit_id, feedback_scope, issue_type, article_genre, problem, before_excerpt, after_excerpt, applicability, preference_evidence, curator_id)
           VALUES ($1, $2, 'reusable_preference', $3, 'event_thread', 'A reader-facing change should appear early.', 'Body 2', 'Start with the practical change, then explain the evidence.', 'When an event thread explains several linked changes before stating their effect.', $4, 'review-admin')`,
          [reusableReview.review_id, reusableEdit.edit_id, issueType, reusableNote],
        );
      }
      const cappedSamples = await (await fetch(`${samplesUrl}?language=en&articleGenre=event_thread&articleId=another-article`, { headers })).json();
      assert.equal(cappedSamples.samples.length, 3, 'retrieval returns no more than three small examples');
      await assert.rejects(
        admin.query(
          `INSERT INTO app.editorial_feedback_samples
            (source_review_id, source_edit_id, feedback_scope, issue_type, article_genre, problem, before_excerpt, after_excerpt, applicability, preference_evidence, curator_id)
           VALUES ($1, $2, 'reusable_preference', 'other', 'event_thread', 'A broad preference without proof.', 'Body 2', 'Start with the practical change, then explain the evidence.', 'When an event thread explains several linked changes before stating their effect.', NULL, 'review-admin')`,
          [reusableReview.review_id, reusableEdit.edit_id],
        ),
        /check constraint/,
        'a reusable preference must have explicit evidence',
      );
      const searchAfterCuration = await (await fetch(`${base}/api/agent/search?${new URLSearchParams({ query: 'integration robotics', types: 'article', language: 'en' })}`)).json();
      assert.doesNotMatch(JSON.stringify(searchAfterCuration), /The opening delays the key caveat|The reader cannot see the practical change|state the practical change before the evidence details/);
      await assert.rejects(admin.query('UPDATE app.editorial_feedback_samples SET problem = \'rewritten sample\' WHERE sample_id = $1', [curatedId]), /append-only/);

      const previewPath = '/articles/previews/integration-test/v2';
      const english = await fetch(`${base}${previewPath}`);
      assert.equal(english.status, 200);
      const englishHtml = await english.text();
      assert.match(englishHtml, /Integration robotics automation preview/);
      assert.match(englishHtml, /PUBLIC PREPRINT · NOT APPROVED/);
      assert.doesNotMatch(englishHtml, /name="robots" content="noindex/);
      assert.match(englishHtml, /Evidence cutoff/);
      assert.match(englishHtml, /Preview full text/);
      assert.match(englishHtml, /table render/);
      assert.match(englishHtml, /<th[^>]*>[\s\S]*?Check[\s\S]*?<\/th>/);

      const chinese = await fetch(`${base}/zh-CN${previewPath}`);
      assert.equal(chinese.status, 200);
      const chineseHtml = await chinese.text();
      assert.match(chineseHtml, /集成机器人自动化预发布/);
      assert.match(chineseHtml, /公开预发布 · 尚未批准/);
      assert.match(chineseHtml, /预发布全文/);

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
      const regularBeforeApproval = await regular.text();
      assert.match(regularBeforeApproval, /href="\/articles\/approved\/integration-test/);
      assert.doesNotMatch(regularBeforeApproval, /Title 2/);
      assert.doesNotMatch(regularBeforeApproval, /PUBLIC PREPRINT/);
      const sitemap = await fetch(`${base}/sitemap.xml`);
      assert.equal(sitemap.status, 200);
      assert.match(await sitemap.text(), /articles\/previews\/integration-test\/v2/);

      const searchParams = new URLSearchParams({ query: 'integration robotics', types: 'article', language: 'en' });
      const articleSearchResponse = await fetch(`${base}/api/agent/search?${searchParams}`);
      assert.equal(articleSearchResponse.status, 200);
      assert.equal(articleSearchResponse.headers.get('cache-control'), 'no-store');
      const articleSearch = await articleSearchResponse.json();
      assert.equal(articleSearch.editorial_articles.available, true);
      assert.equal(articleSearch.results.length, 2);
      const previewResult = articleSearch.results.find((row) => row.status === 'preview');
      const approvedResult = articleSearch.results.find((row) => row.status === 'approved');
      assert.equal(previewResult.id, 'article:integration-test:v2');
      assert.equal(previewResult.review, 'not_approved_public_preview');
      assert.equal(previewResult.date_basis, 'publication_history');
      assert.equal(previewResult.approval_scope.approved_languages, null);
      assert.match(previewResult.url, /articles\/previews\/integration-test\/v2$/);
      assert.equal(previewResult.current_pointers.approved_revision_id, 'article:integration-test:v1');
      assert.equal(previewResult.current_pointers.preview_revision_id, 'article:integration-test:v2');
      assert.match(previewResult.sources[0], /example\.test\/preview-source/);
      assert.equal(approvedResult.id, 'article:integration-test:v1');
      assert.equal(approvedResult.review, 'approved_bilingual');
      assert.deepEqual(approvedResult.approval_scope.approved_languages, ['en', 'zh-CN']);
      assert.doesNotMatch(JSON.stringify(articleSearch), /Readable for the intended audience|comparison group/);

      const articleMcpResponse = await fetch(`${base}/api/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'integration robotics', types: ['article'], language: 'en' } } }),
      });
      const articleMcp = (await articleMcpResponse.json()).result.structuredContent;
      assert.deepEqual(articleMcp.results, articleSearch.results, 'HTTP and MCP expose the same article result semantics');
      const zhSearch = await (await fetch(`${base}/api/agent/search?${new URLSearchParams({ query: '集成机器人自动化', types: 'article', language: 'zh-CN', status: 'preview' })}`)).json();
      assert.equal(zhSearch.results.length, 1);
      assert.equal(zhSearch.results[0].id, 'article:integration-test:v2');
      assert.equal(zhSearch.results[0].language, 'zh-CN');
      assert.match(zhSearch.results[0].url, /zh-CN\/articles\/previews\/integration-test\/v2$/);
      const approvedOnly = await (await fetch(`${base}/api/agent/search?${new URLSearchParams({ query: 'integration robotics', types: 'article', language: 'en', status: 'approved' })}`)).json();
      assert.deepEqual(approvedOnly.results.map((row) => row.id), ['article:integration-test:v1']);
      const afterPublicationWindow = await (await fetch(`${base}/api/agent/search?${new URLSearchParams({ query: 'integration robotics', types: 'article', from: '2099-01-01', language: 'en' })}`)).json();
      assert.deepEqual(afterPublicationWindow.results, [], 'article date filters use disclosed public timestamps');
      const articleOnlyMiss = await (await fetch(`${base}/api/agent/search?${new URLSearchParams({ query: 'model', types: 'article', language: 'en' })}`)).json();
      assert.deepEqual(articleOnlyMiss.results, [], 'article-only queries must not fall back to static record types');
      assert.equal((await fetch(`${base}/api/agent/search?query=integration&types=article&status=private`)).status, 400);

      const articleRecordResponse = await fetch(`${base}/api/agent/record?id=article%3Aintegration-test%3Av2&language=en`);
      assert.equal(articleRecordResponse.status, 200);
      assert.match(articleRecordResponse.headers.get('cache-control'), /no-store/);
      const articleRecord = await articleRecordResponse.json();
      assert.equal(articleRecord.body_markdown.includes('Preview full text'), true);
      assert.equal(articleRecord.status, 'preview');
      assert.equal(articleRecord.review, 'not_approved_public_preview');
      assert.deepEqual(articleRecord.sources[0], { url: 'https://example.test/preview-source', label: 'Public source' });
      assert.equal(articleRecord.structured_limitations.available, false);
      assert.doesNotMatch(JSON.stringify(articleRecord), /Readable for the intended audience|comparison group/);
      const articleMcpRecordResponse = await fetch(`${base}/api/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_record', arguments: { id: 'article:integration-test:v2', language: 'en' } } }),
      });
      assert.deepEqual((await articleMcpRecordResponse.json()).result.structuredContent, articleRecord);

      const saveDecision = async (language, decision, note) => fetch(`${base}/api/admin/editorial`, {
        method: 'POST', headers,
        body: JSON.stringify({ articleId: 'integration-test', version: 2, language,
          contentSha256: language === 'en' ? 'c'.repeat(64) : 'd'.repeat(64),
          reviewScope: 'factual_accuracy', decision, note }),
      });
      assert.equal((await saveDecision('en', 'approve', 'The English claims and caveats match the evidence.')).status, 200);
      assert.equal((await fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify(approveBody) })).status, 422);
      assert.equal((await saveDecision('en', 'hold', 'Recheck the English comparison group.')).status, 200);
      assert.equal((await fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify(approveBody) })).status, 422);
      const chineseBatch = {
        batchId: '105a5f47-120b-4b6d-8c08-49c2eea9d612',
        items: [{ ...approveBody, language: 'zh-CN' }],
      };
      const chineseApproval = await fetch(batchUrl, { method: 'POST', headers, body: JSON.stringify(chineseBatch) });
      assert.equal(chineseApproval.status, 200);
      assert.equal((await chineseApproval.json()).results[0].status, 'language_approved');
      assert.equal((await saveDecision('en', 'approve', 'The English comparison group is now clear.')).status, 200);

      const passingBatch = { batchId: 'd7c2430a-1a30-4ca7-997a-2f115166df37', items: [{ ...approveBody, language: 'en' }] };
      const passingResponse = await fetch(batchUrl, { method: 'POST', headers, body: JSON.stringify(passingBatch) });
      assert.equal(passingResponse.status, 200);
      assert.equal((await passingResponse.json()).results[0].status, 'approved');
      assert.equal((await admin.query("SELECT approved_version FROM editorial.publications WHERE article_id = 'integration-test'")).rows[0].approved_version, 2);
      const completedQueue = await fetch(`${base}/admin/editorial`, { headers: { cookie: authCookie(adminToken) } });
      const completedQueueHtml = (await completedQueue.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
      assert.equal(completedQueue.status, 200);
      const completedApprovals = await admin.query(
        `SELECT r.article_id, r.version, r.language, r.content_sha256, r.decision, r.review_scope,
                r.review_id, r.created_at, l.content_sha256 AS current_hash
           FROM app.editorial_reviews r
           JOIN editorial.localizations l USING (article_id, version, language)
          WHERE r.article_id = 'integration-test' AND r.version = 2 AND r.actor_kind = 'human'
          ORDER BY r.review_id DESC`,
      );
      assert.doesNotMatch(completedQueueHtml, /articleId=integration-test&amp;version=v2/,
        `a fully approved preview disappears from the review queue; approvals=${JSON.stringify(completedApprovals.rows)}\n${log()}`);

      const publishedQueue = await (await fetch(`${base}/admin/editorial?view=published`, { headers })).text();
      assert.match(publishedQueue, /articleId=integration-test&amp;version=v2/);
      assert.match(publishedQueue, /Open published article/);
      const publishedDetail = await (await fetch(`${base}/admin/editorial?articleId=integration-test&version=v2&view=published`, { headers })).text();
      assert.match(publishedDetail, /This version is published/);
      const batchReplay = await fetch(batchUrl, { method: 'POST', headers, body: JSON.stringify(passingBatch) });
      assert.equal((await batchReplay.json()).replayed, true);

      const simultaneousApprovals = await Promise.all([
        fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify(approveBody) }),
        fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify(approveBody) }),
      ]);
      assert.deepEqual(simultaneousApprovals.map((response) => response.status), [200, 200]);
      const approvalResults = await Promise.all(simultaneousApprovals.map((response) => response.json()));
      assert.deepEqual(approvalResults.map((result) => result.publicationChanged).sort(), [false, false]);
      assert.deepEqual((await admin.query("SELECT preview_version, approved_version FROM editorial.publications WHERE article_id = 'integration-test'")).rows[0], { preview_version: 2, approved_version: 2 });
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM editorial.publication_history WHERE article_id = 'integration-test' AND version = 2 AND action = 'approve'")).rows[0].count, 1);

      const regularAfterApproval = await fetch(`${base}/articles`);
      assert.equal(regularAfterApproval.status, 200);
      const regularHtml = await regularAfterApproval.text();
      assert.match(regularHtml, /\/articles\/approved\/integration-test/);
      assert.match(regularHtml, /Integration robotics automation preview/);
      assert.match(regularHtml, /APPROVED/);
      assert.doesNotMatch(regularHtml, /PUBLIC PREPRINT/);

      const stableApproved = await fetch(`${base}/articles/approved/integration-test`);
      assert.equal(stableApproved.status, 200);
      const stableHtml = await stableApproved.text();
      assert.match(stableHtml, /Integration robotics automation preview/);
      assert.match(stableHtml, /APPROVED VERSION/);
      assert.match(stableHtml, /table render/);
      const stableChinese = await fetch(`${base}/zh-CN/articles/approved/integration-test`);
      assert.equal(stableChinese.status, 200);
      assert.match(await stableChinese.text(), /集成机器人自动化预发布/);
      const stableMarkdown = await fetch(`${base}/articles/approved/integration-test/raw.md`);
      assert.equal(stableMarkdown.status, 200);
      assert.match(stableMarkdown.headers.get('content-type'), /text\/markdown/);
      assert.equal(stableMarkdown.headers.get('cache-control'), 'no-store');
      assert.match(stableMarkdown.headers.get('link'), /articles\/approved\/integration-test.*rel="canonical"/);
      assert.match(await stableMarkdown.text(), /Approved version 2/);

      const feed = await (await fetch(`${base}/articles/feed.xml`)).text();
      assert.match(feed, /articles\/approved\/integration-test/);
      const llms = await (await fetch(`${base}/llms.txt`)).text();
      assert.match(llms, /articles\/approved\/integration-test/);
      const approvedSitemap = await (await fetch(`${base}/sitemap.xml`)).text();
      assert.match(approvedSitemap, /articles\/approved\/integration-test/);

      const newlyApproved = await fetch(`${base}${previewPath}`);
      assert.equal(newlyApproved.status, 200);
      assert.match(await newlyApproved.text(), /APPROVED VERSION/);

      await admin.query("INSERT INTO editorial.versions(article_id, version, source_cutoff, created_by) VALUES ('integration-test', 3, now(), 'test')");
      await admin.query("INSERT INTO editorial.localizations VALUES ('integration-test', 3, 'en', 'Title 3', 'Summary 3', 'New preview', repeat('e', 64))");
      await admin.query("INSERT INTO editorial.localizations VALUES ('integration-test', 3, 'zh-CN', '标题三', '摘要三', '新预发布', repeat('f', 64))");
      await admin.query("UPDATE editorial.publications SET preview_version = 3 WHERE article_id = 'integration-test'");
      await admin.query("INSERT INTO editorial.publication_history(article_id, version, action) VALUES ('integration-test', 3, 'preview')");
      const newPreview = await fetch(`${base}/articles/previews/integration-test/v3`);
      assert.equal(newPreview.status, 200);
      assert.match(await newPreview.text(), /PUBLIC PREPRINT · NOT APPROVED/);
      const stableAfterNewPreview = await fetch(`${base}/articles/approved/integration-test`);
      assert.equal(stableAfterNewPreview.status, 200);
      const stableAfterNewPreviewHtml = await stableAfterNewPreview.text();
      assert.match(stableAfterNewPreviewHtml, /Integration robotics automation preview/);
      assert.doesNotMatch(stableAfterNewPreviewHtml, /Title 3/);
      const regularAfterNewPreview = await fetch(`${base}/articles`);
      assert.equal(regularAfterNewPreview.status, 200);
      assert.match(await regularAfterNewPreview.text(), /Integration robotics automation preview/);

      const historicalRecordResponse = await fetch(`${base}/api/agent/record?id=article%3Aintegration-test%3Av1&language=en`);
      assert.equal(historicalRecordResponse.status, 200);
      const historicalRecord = await historicalRecordResponse.json();
      assert.equal(historicalRecord.status, 'approved_historical');
      assert.match(historicalRecord.url, /articles\/previews\/integration-test\/v1$/);
      assert.equal(historicalRecord.body_markdown, 'Article body with a source [Official report](https://example.test/source).');

      const approved = await fetch(`${base}/articles/previews/integration-test/v1`);
      assert.equal(approved.status, 200);
      assert.match(await approved.text(), /APPROVED VERSION/);
      await admin.query("UPDATE editorial.publications SET preview_version = 1 WHERE article_id = 'integration-test'");
      assert.equal((await fetch(approveUrl, { method: 'POST', headers, body: JSON.stringify({ articleId: 'integration-test', version: 1, contentSha256: { en: 'a'.repeat(64), 'zh-CN': 'b'.repeat(64) } }) })).status, 409);
      await admin.query("UPDATE editorial.publications SET preview_version = 2 WHERE article_id = 'integration-test'");
      assert.equal((await fetch(`${base}/articles/previews/integration-test/v3`)).status, 404);
      await admin.query("UPDATE editorial.publications SET preview_version = 3 WHERE article_id = 'integration-test'");
      const withdrawalBody = { articleId: 'integration-test', expectedPreviewVersion: 3, expectedApprovedVersion: 2, reason: 'The source was corrected and the public article is misleading.' };
      assert.equal((await fetch(withdrawalUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(withdrawalBody) })).status, 404);
      assert.equal((await fetch(withdrawalUrl, { method: 'POST', headers: { cookie: authCookie(readerToken), origin: base, 'content-type': 'application/json' }, body: JSON.stringify(withdrawalBody) })).status, 404);
      assert.equal((await fetch(withdrawalUrl, { method: 'POST', headers: { ...headers, origin: 'https://attacker.example' }, body: JSON.stringify(withdrawalBody) })).status, 403);
      assert.equal((await fetch(withdrawalUrl, { method: 'POST', headers, body: JSON.stringify({ ...withdrawalBody, reason: 'short' }) })).status, 400);
      assert.equal((await fetch(withdrawalUrl, { method: 'POST', headers, body: JSON.stringify({ ...withdrawalBody, expectedPreviewVersion: 2 }) })).status, 409);
      assert.equal((await fetch(withdrawalUrl, { method: 'POST', headers, body: JSON.stringify(withdrawalBody) })).status, 422);
      const recordWithdrawal = async (language, hash, note) => fetch(`${base}/api/admin/editorial`, {
        method: 'POST', headers,
        body: JSON.stringify({ articleId: 'integration-test', version: 3, language, contentSha256: hash,
          reviewScope: 'publication', decision: 'withdraw', note }),
      });
      assert.equal((await recordWithdrawal('en', 'e'.repeat(64), 'The corrected source invalidates the English claims.')).status, 200);
      assert.equal((await fetch(withdrawalUrl, { method: 'POST', headers, body: JSON.stringify(withdrawalBody) })).status, 422);
      assert.equal((await recordWithdrawal('zh-CN', 'f'.repeat(64), '来源更正使中文文章结论不再成立。')).status, 200);
      const withdrawn = await fetch(withdrawalUrl, { method: 'POST', headers, body: JSON.stringify(withdrawalBody) });
      assert.equal(withdrawn.status, 200);
      assert.deepEqual(await withdrawn.json(), { articleId: 'integration-test', publicationChanged: true });
      const withdrawnAgain = await fetch(withdrawalUrl, { method: 'POST', headers, body: JSON.stringify(withdrawalBody) });
      assert.deepEqual(await withdrawnAgain.json(), { articleId: 'integration-test', publicationChanged: false });
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM editorial.publication_history WHERE article_id = 'integration-test' AND version = 3 AND action = 'withdraw'")).rows[0].count, 1);
      assert.match((await admin.query("SELECT withdrawal_reason FROM editorial.articles WHERE article_id = 'integration-test'")).rows[0].withdrawal_reason, /source was corrected/);
      assert.equal((await fetch(`${base}${previewPath}`)).status, 404);
      assert.equal((await fetch(`${base}${previewPath}/raw.md`)).status, 404);
      assert.equal((await fetch(`${base}/articles/approved/integration-test`)).status, 404);
      assert.equal((await fetch(`${base}/articles/approved/integration-test/raw.md`)).status, 404);
      assert.doesNotMatch(await (await fetch(`${base}/articles`)).text(), /articles\/approved\/integration-test/);
      const withdrawnSitemap = await (await fetch(`${base}/sitemap.xml`)).text();
      assert.doesNotMatch(withdrawnSitemap, /articles\/previews\/integration-test\/v2/);
      assert.doesNotMatch(withdrawnSitemap, /articles\/approved\/integration-test/);
      const withdrawnSearch = await (await fetch(`${base}/api/agent/search?${new URLSearchParams({ query: 'integration robotics', types: 'article', language: 'en' })}`)).json();
      assert.deepEqual(withdrawnSearch.results, []);
      assert.equal((await fetch(`${base}/api/agent/record?id=article%3Aintegration-test%3Av2`)).status, 404);
      if (process.env.EDITORIAL_BROWSER_MODULE) {
        const { verifyEditorialBrowser } = await import('./editorial-browser.mjs');
        await verifyEditorialBrowser({ admin, base, cookie: authCookie(adminToken) });
      }
    } finally {
      await stop(proc);
    }
  } finally {
    await admin.end();
  }
});
