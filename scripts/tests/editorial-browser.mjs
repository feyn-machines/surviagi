/** Optional real-browser acceptance, using the schema test's disposable database and administrator.
 * Set EDITORIAL_BROWSER_MODULE to an installed playwright-core module and CHROMIUM_PATH if needed.
 * No real accounts, articles or approval records are touched.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyEditorialBrowser({ admin, base, cookie }) {
  const { chromium } = await import(process.env.EDITORIAL_BROWSER_MODULE);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const output = process.env.EDITORIAL_BROWSER_OUTPUT || '/tmp/editorial-ux-browser';
  await mkdir(output, { recursive: true });
  const articleId = 'browser-review-fixture';
  const enTitle = 'A cheaper agent model does not automatically make work cheaper';
  const zhTitle = 'Agent 模型更便宜，工作的总成本也更低吗？';
  await admin.query("INSERT INTO editorial.articles(article_id) VALUES ($1)", [articleId]);
  await admin.query("INSERT INTO editorial.versions(article_id, version, source_cutoff, created_by) VALUES ($1, 1, now(), 'browser-test')", [articleId]);
  for (const language of ['en', 'zh-CN']) {
    await admin.query("INSERT INTO editorial.localizations VALUES ($1, 1, $2, $3, $4, $5, $6)", [articleId, language, language === 'en' ? enTitle : zhTitle,
      language === 'en' ? 'Model price is one input. Review the evidence, human supervision and total workflow costs before drawing conclusions.' : '模型价格只是一个因素。判断工作是否更便宜，还要考虑证据、人工监督与完整流程的成本。',
      language === 'en' ? '# Review the evidence\n\nA lower model price does not establish lower total work costs.\n\n## What to check\n\nCompare supervision and retries.\n\n[Official source](https://example.test/evidence)' : '# 审视证据\n\n模型价格下降，并不能证明工作的总成本下降。\n\n## 要核对什么\n\n比较人工监督与重试成本。\n\n[官方来源](https://example.test/evidence)', language === 'en' ? '1'.repeat(64) : '2'.repeat(64)]);
  }
  await admin.query("INSERT INTO editorial.publications(article_id, preview_version) VALUES ($1, 1)", [articleId]);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const [cookieName, ...cookieValue] = cookie.split('=');
    await context.addCookies([{ name: cookieName, value: cookieValue.join('='), url: base }]);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const waitFor = async (predicate, message) => {
      for (let i = 0; i < 80; i++) { if (await predicate()) return; await page.waitForTimeout(100); }
      assert.fail(message);
    };
    await page.goto(`${base}/zh-CN/admin/editorial`);
    await page.getByRole('searchbox', { name: '搜索文章' }).fill('Agent');
    assert.equal(await page.getByRole('heading', { name: enTitle }).count(), 1);
    await page.getByRole('heading', { name: zhTitle }).waitFor();
    assert.equal(await page.getByRole('heading', { name: zhTitle }).count(), 1);
    await page.screenshot({ path: join(output, 'queue-desktop.png'), fullPage: true });
    await page.getByRole('heading', { name: zhTitle }).getByRole('link').click();
    const approve = page.getByRole('button', { name: '批准并返回队列' });
    await waitFor(() => approve.isEnabled(), 'Chinese draft should be ready to approve');
    assert.equal(await page.getByRole('article', { name: '稿件正文' }).count(), 1, 'one focused reader');
    assert.equal(await page.locator('iframe').count(), 0, 'no nested site navigation or scrolling');
    // Unsaved feedback must block approval; saving a revision request updates this language.
    await page.getByText('审核意见与修改建议', { exact: true }).click();
    await page.getByLabel('审核意见', { exact: true }).fill('请补充人工监督与重试成本的边界。');
    assert.equal(await approve.isDisabled(), true);
    await page.getByRole('button', { name: '保存审核记录', exact: true }).click();
    await waitFor(() => approve.isEnabled(), 'saving feedback should clear the dirty guard');
    await page.getByText('审核意见与修改建议', { exact: true }).click();
    await page.screenshot({ path: join(output, 'review-desktop.png'), fullPage: true });
    await approve.click();
    await page.waitForURL('**/admin/editorial?view=pending&notice=approved');
    await page.reload();
    assert.equal(await page.getByRole('heading', { name: zhTitle }).count(), 0, 'approved Chinese must leave the queue even after reload');
    assert.equal(await page.getByRole('heading', { name: enTitle }).count(), 1, 'English remains independent');
    await page.getByRole('link', { name: /已批准 · 待发布/ }).click();
    await page.getByRole('heading', { name: zhTitle }).waitFor();
    assert.equal(await page.getByRole('heading', { name: zhTitle }).count(), 1);
    assert.equal(await page.getByRole('checkbox').count(), 0, 'approved drafts are never disabled checkbox tasks');
    await page.screenshot({ path: join(output, 'approved-desktop.png'), fullPage: true });
    await page.getByRole('link', { name: '审核另一种语言 →', exact: true }).click();
    await waitFor(() => approve.isEnabled(), 'English draft should be ready to approve');
    // Mobile review has one reader and no horizontal overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(output, 'review-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await approve.click();
    await page.waitForURL('**/admin/editorial?view=pending&notice=published');
    await page.reload();
    assert.equal(await page.getByRole('heading', { name: enTitle }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: zhTitle }).count(), 0);
    await page.getByRole('link', { name: /^已发布/ }).click();
    await page.getByRole('heading', { name: zhTitle }).waitFor();
    assert.equal(await page.getByRole('heading', { name: zhTitle }).count(), 1);
    await page.screenshot({ path: join(output, 'published-mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const publication = await admin.query('SELECT approved_version FROM editorial.publications WHERE article_id=$1', [articleId]);
    assert.equal(publication.rows[0].approved_version, 1);
    const approvals = await admin.query("SELECT language, count(*)::int FROM app.editorial_reviews WHERE article_id=$1 AND decision='approve' GROUP BY language ORDER BY language", [articleId]);
    assert.deepEqual(approvals.rows, [{ language: 'en', count: 1 }, { language: 'zh-CN', count: 1 }]);
    // Batch controls and English UI are tested on the other unapproved fixture.
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${base}/admin/editorial`);
    await page.getByRole('button', { name: 'Select reviewed drafts' }).click();
    const boxes = page.getByRole('checkbox');
    assert.equal(await boxes.count(), 2);
    await boxes.first().check();
    const batchApprove = page.getByRole('button', { name: /Approve selected drafts \(1\)/ });
    // A network failure remains actionable, does not silently remove rows.
    await page.route('**/api/admin/editorial/approve-batch', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await batchApprove.click();
    await page.getByRole('alert').waitFor();
    assert.equal(await boxes.count(), 2);
    await page.unroute('**/api/admin/editorial/approve-batch');
    await batchApprove.click();
    await waitFor(async () => await page.getByRole('checkbox').count() === 0, 'successful batch leaves selection mode');
    assert.equal(await page.getByRole('link', { name: 'Read & review →' }).count(), 1, 'only the unchecked language remains');
    await page.screenshot({ path: join(output, 'queue-english.png'), fullPage: true });
    await page.getByRole('button', { name: 'Select reviewed drafts' }).click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /Approve selected drafts \(1\)/ }).click();
    await page.getByRole('heading', { name: 'No drafts to review' }).waitFor();
    await page.screenshot({ path: join(output, 'empty-english.png'), fullPage: true });
    assert.deepEqual(pageErrors, []);
    console.log('Browser acceptance passed: bilingual queues, feedback, independent approval, reload, publication, batch retry, empty state, desktop and mobile.');
  } finally { await browser.close(); }
}
