import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assemble, cleanup, exitsWithin, freePort, running, startServer, stop } from "./site-server.mjs";

// These tests start the built server (`pnpm build` first) and read what it answers over HTTP.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STANDALONE = join(ROOT, ".next", "standalone");
const SNAPSHOT_DIR = join(ROOT, "datasets", "published", "latest");
const HAS_SNAPSHOT = existsSync(join(SNAPSHOT_DIR, "manifest.json"));
const LEGAL = ["/privacy", "/terms"];
const FIXED = ["", "/markets", "/occupations", "/topics", "/updates", "/voices", "/articles", "/whitepaper", ...LEGAL];

let site;
const pages = new Map();
const files = new Map();

before(async () => {
  site = await startServer({ SNAPSHOT_DIR });
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      const res = await fetch(`${site.base}${language === "en" ? "" : "/zh-CN"}${path || "/"}`);
      assert.equal(res.status, 200, `${language}${path}`);
      pages.set(`${language}${path}`, await res.text());
    }
  }
  for (const name of ["robots.txt", "sitemap.xml", "llms.txt"]) {
    const res = await fetch(`${site.base}/${name}`);
    assert.equal(res.status, 200, name);
    files.set(name, await res.text());
  }
});

after(async () => {
  await cleanup();
});

const html = (language, path) => pages.get(`${language}${path}`);
const anchors = (page) => [...page.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1]);
const internal = (hrefs) => hrefs.filter((h) => h.startsWith("/") && !h.startsWith("//"));

test("without sign-in settings the site says so and offers no sign-in", async () => {
  const response = await fetch(`${site.base}/api/me`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { enabled: false, user: null, admin: false, subscriptions: { updates: false, weekly: false } });
  assert.equal((await fetch(`${site.base}/zh-CN/api/me`)).status, 404);
  assert.equal((await fetch(`${site.base}/api/auth/get-session`)).status, 404);
  assert.equal((await fetch(`${site.base}/api/submissions`)).status, 404);
  assert.ok(!html("en", "").includes("data-account-menu"));
});


/** The admin page and its endpoints answer 404 to anyone without a session; the page with the site's own 404 page. */
async function assertAdminIsHidden(base) {
  for (const path of ["/admin", "/zh-CN/admin", "/admin?view=decided"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, path);
    assert.match(await res.text(), /404/, path);
  }
  const post = await fetch(`${base}/api/admin/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ handle: "someone", ownerKind: "person", decision: "approve" }),
  });
  assert.equal(post.status, 404);
  assert.equal((await fetch(`${base}/api/admin/subscribers`)).status, 404);
}

test("the admin page and its endpoints are a 404 without sign-in settings", async () => {
  await assertAdminIsHidden(site.base);
});

/** The local app database (`pnpm app:setup`), when its password file exists; null otherwise. */
function localAppUrl() {
  const passwordFile = join(ROOT, "data", "postgres", "app-password");
  if (!existsSync(passwordFile)) return null;
  const password = readFileSync(passwordFile, "utf8").trim();
  return `postgres://oaw_app:${encodeURIComponent(password)}@127.0.0.1:7543/openaiwill_local`;
}

test("with sign-in settings, the account menu and the auth endpoints exist and refuse a foreign origin", { timeout: 60000 }, async (t) => {
  const url = localAppUrl();
  if (!url) return t.skip("no local app database (pnpm app:setup)");
  const port = await freePort();
  const { base, proc } = await startServer(
    {
      SNAPSHOT_DIR,
      APP_DATABASE_URL: url,
      BETTER_AUTH_SECRET: "throwaway-secret-for-the-test-0123456789abcdef",
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      GOOGLE_CLIENT_ID: "dummy-id",
      GOOGLE_CLIENT_SECRET: "dummy-secret",
    },
    port,
  );
  try {
    const me = await fetch(`${base}/api/me`);
    assert.equal(me.status, 200);
    assert.equal(me.headers.get("x-robots-tag"), "noindex");
    assert.deepEqual(await me.json(), { enabled: true, user: null, admin: false, subscriptions: { updates: false, weekly: false } });
    assert.ok((await (await fetch(`${base}/`)).text()).includes("data-account-menu"));
    const session = await fetch(`${base}/api/auth/get-session`);
    assert.equal(session.status, 200);
    assert.equal(session.headers.get("cache-control"), "no-store");
    assert.equal(session.headers.get("x-robots-tag"), "noindex");
    const signIn = await fetch(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      redirect: "manual",
    });
    assert.equal(signIn.headers.get("cache-control"), "no-store");
    assert.equal(signIn.headers.get("x-robots-tag"), "noindex");
    assert.ok(new URL((await signIn.json()).url).hostname === "accounts.google.com", "sign-in points at Google");
    const post = (headers) => fetch(`${base}/api/submissions`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ handle: "@someone", ownerKind: "person" }) });
    assert.equal((await post({ origin: base })).status, 401);
    assert.equal((await post({ origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(`${base}/api/submissions`)).status, 401);
    await assertAdminIsHidden(base);
    // Better Auth checks the origin of a request that carries cookies (the CSRF case); one without cookies changes nothing.
    const headers = { "content-type": "application/json", cookie: "better-auth.session_token=not-a-real-session" };
    const refused = await fetch(`${base}/api/auth/sign-out`, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: "{}" });
    assert.ok(refused.status >= 400, `sign-out from a foreign origin answered ${refused.status}`);
    const own = await fetch(`${base}/api/auth/sign-out`, { method: "POST", headers: { ...headers, origin: base }, body: "{}" });
    assert.ok(own.status < 400, `sign-out from the site's own origin answered ${own.status}`);
  } finally {
    await stop(proc);
  }
});

/** One GET with any Host header (fetch will not send a forged one); the response is not followed. */
function getWithHeaders(base, path, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = httpRequest({ host: url.hostname, port: url.port, path, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location ?? null }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("www.surviagi.com is sent to the apex with the same path and query", async () => {
  for (const path of ["/", "/zh-CN/voices?x=1", "/occupations/11-1011.00", "/api/me", "/markets?lang=zh-CN"]) {
    const answer = await getWithHeaders(site.base, path, { host: "www.surviagi.com" });
    assert.equal(answer.status, 308, path);
    assert.equal(answer.location, `${SITE}${path}`, path);
  }
  // The address the site had before it was renamed lands on the same page at the new one.
  for (const host of ["openaiwill.com", "www.openaiwill.com", "OpenAIWill.com:443"]) {
    for (const path of ["/", "/zh-CN/articles/judgment-for-two-cents", "/occupations/11-1011.00?x=1", "/api/me"]) {
      const answer = await getWithHeaders(site.base, path, { host });
      assert.equal(answer.status, 308, `${host}${path}`);
      assert.equal(answer.location, `${SITE}${path}`, `${host}${path}`);
    }
  }
  // Every address means the files beside the pages too: robots.txt, the sitemap, llms.txt, share images, figures,
  // the icon and the IndexNow key. On the apex they are still served as they are.
  const key = readdirSync(join(ROOT, "public")).find((name) => /^[0-9a-f]{32}\.txt$/.test(name));
  const figure = readdirSync(join(ROOT, "public", "figures"), { recursive: true }).find((name) => name.includes("."));
  const filePaths = ["/robots.txt", "/sitemap.xml", "/llms.txt", "/og/en.png", "/icon.svg",
    ...(key ? [`/${key}`] : []), ...(figure ? [`/figures/${figure}`] : [])];
  for (const host of ["www.surviagi.com", "openaiwill.com", "www.openaiwill.com"]) {
    for (const path of filePaths) {
      const answer = await getWithHeaders(site.base, path, { host });
      assert.equal(answer.status, 308, `${host}${path}`);
      assert.equal(answer.location, `${SITE}${path}`, `${host}${path}`);
    }
  }
  for (const path of filePaths) {
    const answer = await getWithHeaders(site.base, path, { host: "surviagi.com" });
    assert.equal(answer.status, 200, `surviagi.com${path}`);
    assert.equal(answer.location, null, `surviagi.com${path}`);
  }
  // The health check is local and answers on any host.
  assert.equal((await getWithHeaders(site.base, "/healthz", { host: "openaiwill.com" })).status, 200);
  // The case of a host name does not matter; a port or a trailing dot names the same host.
  for (const host of ["WWW.SurviAGI.com", "www.surviagi.com:443", "www.surviagi.com:8080", "www.surviagi.com."]) {
    const answer = await getWithHeaders(site.base, "/voices", { host });
    assert.equal(answer.status, 308, host);
    assert.equal(answer.location, `${SITE}/voices`, host);
  }
});

test("only the one www host is redirected, and the Location is always the fixed apex origin", async () => {
  for (const host of ["surviagi.com", "127.0.0.1", new URL(site.base).host, "www.surviagi.com.evil.example", "evil-www.surviagi.com",
    "wwww.surviagi.com", "sub.www.surviagi.com", "sub.openaiwill.com", "openaiwill.com.evil.example", "www.surviagi.com@evil.example", "evil.example"]) {
    const answer = await getWithHeaders(site.base, "/markets", { host });
    assert.equal(answer.status, 200, host);
    assert.equal(answer.location, null, host);
    const api = await getWithHeaders(site.base, "/api/me", { host });
    assert.equal(api.status, 200, `${host} /api/me`);
  }
  for (const path of ["/%2F%2Fevil.example", "/a?next=https://evil.example"]) {
    const answer = await getWithHeaders(site.base, path, { host: "www.surviagi.com" });
    assert.equal(answer.status, 308, path);
    assert.ok(answer.location.startsWith(`${SITE}/`), `${path} -> ${answer.location}`);
    assert.equal(new URL(answer.location).origin, SITE);
  }
  // Next itself collapses a leading double slash before the proxy runs, with a same-host relative Location:
  // never another host, never protocol-relative.
  for (const path of ["//evil.example/x", "/\\evil.example", "/x//y"]) {
    const answer = await getWithHeaders(site.base, path, { host: "www.surviagi.com" });
    assert.equal(answer.status, 308, path);
    assert.ok(answer.location.startsWith("/") && !answer.location.startsWith("//"), `${path} -> ${answer.location}`);
  }
  // Only the Host header decides: a client-sent X-Forwarded-Host cannot redirect an apex request (to itself, in a loop).
  for (const forwarded of ["www.surviagi.com", "evil.example"]) {
    const answer = await getWithHeaders(site.base, "/voices", { host: "surviagi.com", "x-forwarded-host": forwarded });
    assert.equal(answer.status, 200, forwarded);
    assert.equal(answer.location, null, forwarded);
  }
});

test("a sign-in failure marker does not make another indexable address", async () => {
  const page = await (await fetch(`${site.base}/voices?signin=failed&error=access_denied`)).text();
  assert.equal(tag(page, /<link rel="canonical" href="([^"]+)"/), `${SITE}/voices`);
});

test("the updates page offers a publisher filter only for publishers it lists", { skip: !HAS_SNAPSHOT }, () => {
  const read = (name) => JSON.parse(readFileSync(join(SNAPSHOT_DIR, `${name}.json`), "utf8"));
  const listed = new Set(read("chain").events.map((e) => e.event_id));
  const names = new Map(read("events").map((e) => [e.org_name, e.org_name_zh_cn]));
  const withRows = new Set(read("events").filter((e) => listed.has(e.event_id)).map((e) => e.org_name));
  const without = read("coverage").events_by_organisation.filter((o) => o.events > 0 && !withRows.has(o.org));
  assert.ok(without.some((o) => o.org === "unattributed"), "the data no longer has updates without a publisher");
  for (const language of ["en", "zh-CN"]) {
    const page = html(language, "/updates");
    const chips = [...page.matchAll(/aria-pressed="(?:true|false)"[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
    assert.ok(chips.length > 0, `${language}: no publisher buttons`);
    // A button that filters to nothing is a dead end, and "unattributed" was also shown untranslated.
    for (const o of without) {
      const label = language === "zh-CN" ? names.get(o.org) ?? o.org : o.org;
      assert.ok(!chips.includes(label), `${language}: a button for ${o.org}, which has no listed update`);
    }
    assert.ok(!chips.some((c) => /unattributed/i.test(c)), `${language}: ${chips}`);
  }
});

test("every fixed page answers in both languages", () => {
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      assert.match(html(language, path), new RegExp(`<html[^>]*lang="${language}"`), `${language}${path}`);
    }
  }
});

test("a Chinese page links only to Chinese pages, an English page only to unprefixed ones", () => {
  for (const path of FIXED) {
    for (const link of internal(anchors(html("zh-CN", path)))) {
      assert.ok(link === "/zh-CN" || link.startsWith("/zh-CN/"), `zh-CN${path} links to ${link}`);
    }
    for (const link of internal(anchors(html("en", path)))) {
      assert.ok(!/^\/(en|zh-CN)(\/|$)/.test(link), `en${path} links to ${link}`);
    }
  }
});

test("an address outside the loaded release is a 404 in both languages", async () => {
  for (const prefix of ["", "/zh-CN"]) {
    for (const path of ["/markets/no-such-market", "/occupations/no-such-occupation", "/occupations/g/no-such-group",
      "/updates/no-such-update", "/work/no-such-work"]) {
      const res = await fetch(`${site.base}${prefix}${path}`);
      assert.equal(res.status, 404, `${prefix}${path}`);
    }
  }
  assert.equal((await fetch(`${site.base}/fr/markets`)).status, 404);
});

test("a path the proxy skips is not a page under some other language segment", async () => {
  // The proxy leaves these prefixes to the file server, so a miss reaches `[lang]` with "og", "figures" or the
  // file name as the language. That is a 404, not a duplicate of an English page.
  for (const path of ["/og/markets", "/figures/voices", "/og/privacy", "/figures/topics", "/0123456789abcdef0123456789abcdef.txt"]) {
    const res = await fetch(`${site.base}${path}`, { redirect: "manual" });
    assert.equal(res.status, 404, path);
    assert.match(await res.text(), /404/, path);
  }
  // The files those prefixes are for still answer.
  for (const path of ["/og/en.png", "/icon.svg"]) assert.equal((await fetch(`${site.base}${path}`)).status, 200, path);
  const key = readdirSync(join(ROOT, "public")).find((name) => /^[0-9a-f]{32}\.txt$/.test(name));
  if (key) assert.equal((await fetch(`${site.base}/${key}`)).status, 200, key);
});

test("with a snapshot, a detail page of each kind answers", { skip: !HAS_SNAPSHOT }, async () => {
  const locs = [...files.get("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const section of ["markets", "occupations/g", "occupations", "updates", "work"]) {
    for (const prefix of ["https://surviagi.com", "https://surviagi.com/zh-CN"]) {
      const loc = locs.find((l) =>
        l.startsWith(`${prefix}/${section}/`) && (section !== "occupations" || !l.startsWith(`${prefix}/occupations/g/`)));
      // An update keeps its original words in both languages, so only the English address is listed.
      if (section === "updates" && prefix.endsWith("/zh-CN")) {
        assert.equal(loc, undefined, "a Chinese update address is in the sitemap");
        continue;
      }
      assert.ok(loc, `${prefix}/${section} is not in the sitemap`);
      assert.equal((await fetch(`${site.base}${new URL(loc).pathname}`)).status, 200, loc);
    }
  }
});

test("market, occupation and sector pages open with one dated sentence that answers them", { skip: !HAS_SNAPSHOT }, async () => {
  const date = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "manifest.json"), "utf8")).generated_at.slice(0, 10);
  const locs = [...files.get("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  const opening = { en: `As of ${date}, `, "zh-CN": `截至 ${date}，` };
  for (const section of ["/markets/", "/occupations/", "/occupations/g/"]) {
    // Sitemap occupations have evidence; a market with none is a dead end the sentence must still answer.
    const path = locs.find((l) => l.startsWith(section) && (section === "/occupations/g/" || !l.startsWith("/occupations/g/")));
    assert.ok(path, `no ${section} page in the sitemap`);
    for (const [language, prefix] of [["en", ""], ["zh-CN", "/zh-CN"]]) {
      const page = await (await fetch(`${site.base}${prefix}${path}`)).text();
      const title = page.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1];
      const sentence = page.match(new RegExp(`<p[^>]*>(${opening[language]}[^<]+)</p>`))?.[1];
      assert.ok(sentence, `${language}${path}: no dated answer`);
      assert.ok(title && sentence.includes(title), `${language}${path}: the answer does not name ${title}`);
      assert.ok(!/\{\w+\}/.test(sentence), `${language}${path}: unfilled placeholder in ${sentence}`);
    }
  }
});

test("work, market and occupation pages name a Markdown copy that says what the page says", { skip: !HAS_SNAPSHOT }, async () => {
  const locs = [...files.get("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  const text = (page) => page.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
  for (const section of ["/work/", "/markets/", "/occupations/"]) {
    const path = locs.find((l) => l.startsWith(section) && !l.startsWith("/occupations/g/"));
    assert.ok(path, `no ${section} page in the sitemap`);
    for (const prefix of ["", "/zh-CN"]) {
      const page = await (await fetch(`${site.base}${prefix}${path}`)).text();
      const copyUrl = `${SITE}${prefix}${path}/raw.md`;
      assert.ok(page.includes(`<link rel="alternate" type="text/markdown" href="${copyUrl}"/>`), `${prefix}${path}: no Markdown alternate`);

      const res = await fetch(`${site.base}${prefix}${path}/raw.md`);
      assert.equal(res.status, 200, copyUrl);
      assert.match(res.headers.get("content-type"), /^text\/markdown/);
      assert.equal(res.headers.get("link"), `<${SITE}${prefix}${path}>; rel="canonical"`);
      const md = await res.text();
      const title = page.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1];
      assert.ok(md.startsWith(`# ${text(title)}\n`), `${copyUrl} does not open with the page's title`);
      // The quoted line is the page's own dated answer, word for word.
      const answer = md.match(/^> (.+)$/m)?.[1];
      assert.ok(answer && text(page).includes(answer), `${copyUrl}: "${answer}" is not on the page`);
      assert.ok(!/\{\w+\}/.test(md), `${copyUrl}: unfilled placeholder`);
      assert.ok(!/\]\(\//.test(md), `${copyUrl}: a link without its address`);
      assert.match(md, prefix ? /由机器提出/ : /Machine-proposed/);
    }
  }
  for (const missing of ["/work/no-such-work/raw.md", "/markets/no-such-market/raw.md", "/occupations/00-0000.00/raw.md"]) {
    assert.equal((await fetch(`${site.base}${missing}`)).status, 404, missing);
  }
  const example = body("llms.txt").match(/https:\/\/surviagi\.com(\/markets\/[^ ]+\/raw\.md)/)?.[1];
  assert.ok(example, "llms.txt names no Markdown copy");
  assert.equal((await fetch(`${site.base}${example}`)).status, 200, example);
  // An article's copy points back at its page the same way.
  const article = body("llms.txt").match(/\]\(https:\/\/surviagi\.com(\/articles\/[^)]+)\/raw\.md\)/)?.[1];
  if (article) {
    const res = await fetch(`${site.base}${article}/raw.md`);
    assert.equal(res.headers.get("link"), `<${SITE}${article}>; rel="canonical"`);
  }
});

test("update pages and the whitepaper name a Markdown copy that points back at the page to keep", { skip: !HAS_SNAPSHOT }, async () => {
  const locs = [...files.get("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  const update = locs.find((l) => l.startsWith("/updates/"));
  assert.ok(update, "no update page in the sitemap");
  for (const prefix of ["", "/zh-CN"]) {
    const page = await (await fetch(`${site.base}${prefix}${update}`)).text();
    assert.ok(page.includes(`<link rel="alternate" type="text/markdown" href="${SITE}${prefix}${update}/raw.md"/>`), `${prefix}${update}: no Markdown alternate`);
    const res = await fetch(`${site.base}${prefix}${update}/raw.md`);
    assert.equal(res.status, 200, `${prefix}${update}/raw.md`);
    assert.match(res.headers.get("content-type"), /^text\/markdown/);
    // An update has one page to keep, the English one, in both languages.
    assert.equal(res.headers.get("link"), `<${SITE}${update}>; rel="canonical"`);
    const md = await res.text();
    const title = page.match(/<h1[^>]*>([^<]+)</)?.[1].replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
    assert.ok(title && md.startsWith(`# ${title}\n`), `${prefix}${update}/raw.md does not open with the page's title`);
    assert.ok(!/\{\w+\}/.test(md), `${prefix}${update}/raw.md: unfilled placeholder`);
    assert.ok(!/\]\(\//.test(md), `${prefix}${update}/raw.md: a link without its address`);
    assert.match(md, prefix ? /由机器提出/ : /Machine-proposed/);
  }
  assert.equal((await fetch(`${site.base}/updates/ev-no-such-update/raw.md`)).status, 404);

  for (const prefix of ["", "/zh-CN"]) {
    const page = html(prefix ? "zh-CN" : "en", "/whitepaper");
    assert.ok(page.includes(`<link rel="alternate" type="text/markdown" href="${SITE}${prefix}/whitepaper/raw.md"/>`), `${prefix}/whitepaper: no Markdown alternate`);
    const res = await fetch(`${site.base}${prefix}/whitepaper/raw.md`);
    assert.equal(res.status, 200, `${prefix}/whitepaper/raw.md`);
    assert.equal(res.headers.get("link"), `<${SITE}${prefix}/whitepaper>; rel="canonical"`);
    const md = await res.text();
    assert.ok(!md.includes("<a id="), `${prefix}/whitepaper/raw.md keeps the anchor tags`);
    assert.match(md, /^# \S/, `${prefix}/whitepaper/raw.md does not open with a title`);
    assert.ok(!/\]\((?:#|\/)/.test(md), `${prefix}/whitepaper/raw.md: a link without its address`);
    // One language per copy: the English copy has no Chinese heading and the Chinese copy no English one.
    const title = md.split("\n")[0];
    assert.equal(/[\u4e00-\u9fff]/.test(title), Boolean(prefix), `${prefix}/whitepaper/raw.md is in the wrong language: ${title}`);
  }
});

test("a work's level is the highest reading published under it, and the posts that confirmed one are on its page", { skip: !HAS_SNAPSHOT }, async () => {
  const chain = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "chain.json"), "utf8"));
  const levels = new Map();
  for (const row of chain.evidence) {
    for (const level of [row.level, ...(row.confirmations ?? []).map((v) => v.level)]) {
      if (level !== null) levels.set(row.activity_id, Math.max(levels.get(row.activity_id) ?? 0, level));
    }
  }
  // Until 2026-10-16 the confirmations were counted and not published: a page stood at L3 over L2 readings.
  for (const activity of chain.activities.filter((a) => a.level !== null)) {
    const shown = levels.get(activity.activity_id);
    assert.ok(shown !== undefined && (activity.gated ? Math.min(shown, 3) : shown) === activity.level,
      `${activity.activity_id} stands at L${activity.level} over readings that reach L${shown}`);
  }
  const confirmed = chain.evidence.find((row) => row.confirmations?.length);
  if (!confirmed) return;
  const [first] = confirmed.confirmations;
  const path = `/work/${confirmed.activity_id.replace(/^oaw:market:/, "")}`;
  const page = await (await fetch(`${site.base}${path}`)).text();
  assert.ok(page.includes(`href="${first.url}"`), `${path} does not link the post that confirmed it`);
  const md = await (await fetch(`${site.base}/zh-CN${path}/raw.md`)).text();
  assert.ok(md.includes(`第三方印证：[@${first.handle}](${first.url})`), `${path}/raw.md does not name the confirmation`);
});

test("a work page says when its level was first reached, and its history ends where the work stands", { skip: !HAS_SNAPSHOT }, async () => {
  const chain = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "chain.json"), "utf8"));
  const confirmed = new Set(chain.evidence.filter((row) => row.confirmations?.length).map((row) => row.activity_id));
  const reached = chain.activities.filter((a) => a.evidence_rows && a.level);
  // One a confirmation carried, if there is one, and a plain one.
  const sample = [reached.find((a) => confirmed.has(a.activity_id)), reached.find((a) => !confirmed.has(a.activity_id))].filter(Boolean);
  assert.ok(sample.length > 0, "no work with a level");
  for (const work of sample) {
    const path = `/work/${work.activity_id.replace(/^oaw:market:/, "")}`;
    for (const [prefix, heading, sentence] of [["", "## How it got here", /It first reached L(\d) on (\d{4}-\d\d-\d\d)\./], ["/zh-CN", "## 它是怎么走到这里的", /它在 (\d{4}-\d\d-\d\d) 首次达到 L(\d)。/]]) {
      const md = await (await fetch(`${site.base}${prefix}${path}/raw.md`)).text();
      const section = md.split(heading)[1]?.split("\n## ")[0];
      assert.ok(section, `${prefix}${path}/raw.md has no history`);
      const steps = section.split("\n").filter((line) => line.startsWith("- "));
      assert.ok(steps.length > 0, `${prefix}${path}: an empty history`);
      // Each step rises, and the last one ends at the work's level.
      // The rise closes the line, so its level is the last "L<n> " on it.
      const tops = steps.map((line) => Number([...line.matchAll(/L(\d) /g)].at(-1)?.[1]));
      assert.deepEqual(tops, [...tops].sort((a, b) => a - b), `${prefix}${path}: a step that does not rise`);
      assert.equal(tops.at(-1), work.level, `${prefix}${path}: the history ends at L${tops.at(-1)}, the work stands at L${work.level}`);
      const said = section.match(sentence);
      if (said) {
        const [level, date] = prefix ? [said[2], said[1]] : [said[1], said[2]];
        assert.equal(Number(level), work.level);
        assert.ok(steps.at(-1).includes(date), `${prefix}${path}: first reached on ${date}, but the last step is ${steps.at(-1)}`);
        const page = await (await fetch(`${site.base}${prefix}${path}`)).text();
        assert.ok(page.includes(said[0]), `${prefix}${path}: the page does not say ${said[0]}`);
      }
    }
  }
});

test("every data page asks to be rendered per request, so none is baked into the build", () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name === "page.tsx" ? [join(dir, entry.name)] : []);
  for (const file of walk(join(ROOT, "src", "app", "[lang]"))) {
    const text = readFileSync(file, "utf8");
    // Only the whitepaper and the articles are built ahead: they read documents the server does not carry.
    // The legal pages read nothing, but the layout's sign-in menu depends on the server's settings, so they
    // render per request too.
    if (/[\\/](whitepaper|articles)[\\/]/.test(file)) assert.match(text, /export const dynamic = "force-static"/, file);
    else assert.match(text, /export const dynamic = "force-dynamic"/, file);
  }
});

test("every market in the loaded data belongs to a market group the home page can draw", { skip: !HAS_SNAPSHOT }, () => {
  const chain = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "chain.json"), "utf8"));
  const stored = JSON.parse(readFileSync(join(ROOT, "src", "content", "market-groups.json"), "utf8"));
  const markets = new Set(chain.activities.map((a) => a.market_id));
  assert.ok(markets.size > 0);
  const ungrouped = [...markets].filter((id) => !stored.groups[stored.group_of_market[id]]);
  assert.deepEqual(ungrouped, [], "markets with no group are left off the home page");
});

test("the standalone output carries the database client and the data loader", () => {
  assert.ok(existsSync(join(STANDALONE, "node_modules", "pg", "package.json")), "pg is not in the standalone output");
  const server = join(STANDALONE, ".next", "server");
  assert.ok(existsSync(join(server, "instrumentation.js")), "instrumentation.js is not in the standalone output");
  const chunks = join(server, "chunks");
  const loader = readdirSync(chunks).some((name) => readFileSync(join(chunks, name), "utf8").includes("[data-release]"));
  assert.ok(loader, "the data loader is not in the standalone server bundle");
});

test("/healthz names the data release and is not cached", async () => {
  const res = await fetch(`${site.base}/healthz`);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { ok, data, app } = await res.json();
  assert.equal(ok, true);
  assert.deepEqual(app, { enabled: false });
  assert.equal(res.status, 200);
  if (HAS_SNAPSHOT) {
    assert.equal(data.source, "files");
    assert.match(data.releaseId, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  } else {
    assert.deepEqual(data, { releaseId: null, source: "none", loadedAt: null });
  }
});

const SITE = "https://surviagi.com";
// Next writes the site root without its trailing slash; the two spell the same address.
const publicUrl = (language, path) => `${SITE}${language === "en" ? path : `/zh-CN${path}`}`;
const tag = (page, pattern) => page.match(pattern)?.[1] ?? null;

test("each page names its own address and its counterpart in the other language", () => {
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      const page = html(language, path);
      const where = `${language}${path}`;
      assert.equal(tag(page, /<link rel="canonical" href="([^"]+)"/), publicUrl(language, path), where);
      assert.equal(tag(page, /<link rel="alternate" hrefLang="en" href="([^"]+)"/), publicUrl("en", path), where);
      assert.equal(tag(page, /<link rel="alternate" hrefLang="zh-CN" href="([^"]+)"/), publicUrl("zh-CN", path), where);
      assert.equal(tag(page, /<link rel="alternate" hrefLang="x-default" href="([^"]+)"/), publicUrl("en", path), where);
      assert.equal(tag(page, /<meta property="og:url" content="([^"]+)"/), publicUrl(language, path), where);
      assert.equal(tag(page, /<meta property="og:image" content="([^"]+)"/), `${SITE}/og/${language}.png`, where);
      assert.ok(tag(page, /<meta name="description" content="([^"]+)"/), where);
      assert.equal(tag(page, /<meta name="twitter:site" content="([^"]+)"/), "@surviagi", where);
    }
  }
});

test("every page links to the project's accounts in the header and in the footer", () => {
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      const links = anchors(html(language, path));
      for (const url of ["https://x.com/surviagi", "https://discord.gg/ArVHw2K9X", "https://github.com/feyn-machines/surviagi"]) {
        // The legal pages also name X and Discord once, as the way to reach us.
        const contact = LEGAL.includes(path) && !url.includes("github") ? 1 : 0;
        assert.equal(links.filter((link) => link === url).length, 2 + contact, `${language}${path}: ${url} should appear in header and footer`);
      }
    }
  }
});

test("the default title is the confirmed headline, not the retired one", () => {
  assert.match(html("en", ""), /<title>How far AI has taken over the world<\/title>/);
  assert.match(html("zh-CN", ""), /<title>AI 接管世界的进度<\/title>/);
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) assert.doesNotMatch(html(language, path), /<title>[^<]*Kill Your Idea/);
  }
});

const BANNED_CLAIMS = /replacement rate|% of jobs|probability of failure|verified score|share AI|AI finishes|替代率|失败概率|已审核|占比|做完其中多少/i;

test("no page claims a replacement share, a probability or a reviewed score", () => {
  const banned = BANNED_CLAIMS;
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      const page = html(language, path);
      assert.doesNotMatch(tag(page, /<title>([^<]*)<\/title>/) ?? "", banned);
      assert.doesNotMatch(tag(page, /<meta name="description" content="([^"]+)"/) ?? "", banned);
    }
  }
});

test("no Dataset JSON-LD description claims a share", () => {
  for (const language of ["en", "zh-CN"]) {
    for (const path of ["/markets", "/occupations"]) {
      const blocks = [...html(language, path).matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
      const datasets = blocks.flat().filter((b) => b?.["@type"] === "Dataset");
      if (HAS_SNAPSHOT) assert.ok(datasets.length > 0, `${language}${path} has no Dataset`);
      for (const d of datasets) assert.doesNotMatch(d.description ?? "", BANNED_CLAIMS, `${language}${path}`);
    }
  }
});

test("the privacy and terms pages say what is stored and how to ask for deletion, and make no forbidden claim", () => {
  const text = (page) => page.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
  for (const language of ["en", "zh-CN"]) {
    const privacy = text(html(language, "/privacy"));
    assert.match(privacy, language === "en" ? /email address/ : /邮箱/);
    assert.match(privacy, language === "en" ? /deleted/ : /删除/);
    assert.match(privacy, language === "en" ? /14 days/ : /14 天/);
    const terms = text(html(language, "/terms"));
    assert.match(terms, language === "en" ? /not been reviewed/ : /未经审核/);
    for (const page of [privacy, terms]) {
      assert.doesNotMatch(page, BANNED_CLAIMS);
      assert.doesNotMatch(page, language === "en" ? /platform/i : /平台/);
      assert.doesNotMatch(page, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, "no e-mail address");
    }
    for (const path of LEGAL) {
      assert.match(html(language, path), /<h1[^>]*>[^<]+<\/h1>/);
    }
  }
});

test("every page's footer links to the privacy and terms pages in its own language", () => {
  for (const language of ["en", "zh-CN"]) {
    const prefix = language === "en" ? "" : "/zh-CN";
    for (const path of FIXED) {
      const links = anchors(html(language, path));
      for (const legal of LEGAL) assert.ok(links.includes(`${prefix}${legal}`), `${language}${path} lacks ${prefix}${legal}`);
    }
  }
});

test("the privacy and terms pages are in the sitemap", () => {
  const locs = [...body("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const legal of LEGAL) {
    assert.ok(locs.includes(`${SITE}${legal}`), legal);
    assert.ok(locs.includes(`${SITE}/zh-CN${legal}`), `zh-CN${legal}`);
  }
});

const body = (name) => files.get(name);

test("robots.txt allows every page, keeps crawlers out of the admin and the API, names the AI crawlers, and points at the sitemap", () => {
  const robots = body("robots.txt");
  assert.match(robots, /Sitemap: https:\/\/surviagi\.com\/sitemap\.xml/);
  const groups = robots.split(/\n\s*\n/).filter((group) => /User-Agent:/i.test(group));
  assert.equal(groups.length, 13);
  for (const group of groups) {
    assert.match(group, /^Allow: \/$/m, group);
    for (const path of ["/admin", "/zh-CN/admin", "/api/"]) assert.match(group, new RegExp(`^Disallow: ${path}$`, "m"), `${path} in ${group}`);
    assert.deepEqual([...group.matchAll(/^Disallow: (.*)$/gm)].map((m) => m[1]).sort(), ["/admin", "/api/", "/zh-CN/admin"]);
  }
  for (const bot of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User",
    "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot", "Bytespider"]) {
    assert.match(robots, new RegExp(`User-Agent: ${bot}\\b`, "i"), bot);
  }
});

test("the sitemap lists each address once, with its counterpart, and the addresses answer", async () => {
  const xml = body("sitemap.xml");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= FIXED.length * 2);
  assert.equal(new Set(locs).size, locs.length, "duplicate addresses");
  for (const loc of locs) assert.ok(loc.startsWith(`${SITE}/`) || loc === SITE, loc);
  assert.match(xml, /hreflang="zh-CN"/);
  assert.match(xml, /hreflang="x-default"/);
  for (const [, time] of xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g))
    assert.match(time, /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2}))?$/, `a time not written to the second: ${time}`);
  assert.ok(!locs.some((loc) => /\/admin(\/|$)/.test(loc)), "the admin page is not in the sitemap");
  assert.ok(!/\/admin\b/.test(body("llms.txt")), "the admin page is not in llms.txt");
  // The first, the last and twenty evenly spaced addresses between them.
  const sample = new Set([locs[0], locs[locs.length - 1]]);
  for (let i = 0; i < 20; i += 1) sample.add(locs[Math.floor((i * (locs.length - 1)) / 19)]);
  for (const loc of sample) {
    const res = await fetch(`${site.base}${decodeURI(loc.slice(SITE.length)) || "/"}`);
    assert.equal(res.status, 200, loc);
  }
});

test("a detail page's lastmod is when its newest dated evidence happened, never when the data was published", { skip: !HAS_SNAPSHOT }, () => {
  const read = (name) => JSON.parse(readFileSync(join(SNAPSHOT_DIR, `${name}.json`), "utf8"));
  const { events, evidence, activities } = read("chain");
  const progress = read("progress");
  const second = (time) => time.replace(/(T\d{2}:\d{2}:\d{2})\.\d+/, "$1");
  const latest = (times) => times.filter(Boolean).sort().at(-1) ?? null;

  // The same joins the pages make: work -> its readings; market -> its work; occupation -> the markets serving it;
  // group -> its occupations.
  const occurred = new Map(events.map((e) => [e.event_id, e.occurred_at]));
  const byActivity = new Map();
  for (const row of evidence) byActivity.set(row.activity_id, latest([byActivity.get(row.activity_id), occurred.get(row.event_id)]));
  const byMarket = new Map();
  for (const a of activities) byMarket.set(a.market_id, latest([byMarket.get(a.market_id), byActivity.get(a.activity_id)]));
  const byOccupation = new Map();
  for (const edge of read("markets")) {
    byOccupation.set(edge.occupation_id, latest([byOccupation.get(edge.occupation_id), byMarket.get(edge.market_id)]));
  }
  const byGroup = new Map();
  for (const [id, entry] of Object.entries(progress.occupations)) {
    byGroup.set(entry.group_id, latest([byGroup.get(entry.group_id), byOccupation.get(id)]));
  }
  const topicDates = new Map(read("topics").map((t) => [t.slug, t.latest_claim_at]));
  const expected = (path) => {
    let m;
    if ((m = path.match(/^\/updates\/(.+)$/))) return occurred.get(m[1]) ?? null;
    if ((m = path.match(/^\/topics\/(.+)$/))) return topicDates.get(m[1]) ?? null;
    if ((m = path.match(/^\/work\/(.+)$/))) return byActivity.get(`oaw:market:${m[1]}`);
    if ((m = path.match(/^\/markets\/(.+)$/))) return byMarket.get(`oaw:market:${m[1]}`);
    if ((m = path.match(/^\/occupations\/g\/(.+)$/))) return byGroup.get(`oaw:occupation-group:${m[1]}`);
    if ((m = path.match(/^\/occupations\/(.+)$/))) return byOccupation.get(`oaw:occupation:${m[1]}`);
    return undefined;
  };

  let checked = 0;
  let dated = 0;
  for (const [entry] of body("sitemap.xml").matchAll(/<url>[\s\S]*?<\/url>/g)) {
    const loc = entry.match(/<loc>([^<]+)<\/loc>/)[1];
    const lastmod = entry.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
    const path = decodeURI(loc.slice(SITE.length)).replace(/^\/zh-CN(?=\/|$)/, "");
    const want = expected(path);
    if (want === undefined) continue;
    checked += 1;
    if (want) dated += 1;
    // Without a dated reading there is no honest time, and the publication time would move at every release.
    assert.equal(lastmod, want ? second(want) : undefined, loc);
  }
  assert.ok(checked > 0, "no detail page in the sitemap");
  assert.ok(checked > dated, "every detail page is dated, so the undated case went untested");
  assert.ok(dated > 0, "no detail page carries the date of its evidence");
});

const ld = (page) =>
  [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => {
    const value = JSON.parse(m[1]);
    return Array.isArray(value) ? value : [value];
  });
const types = (page) => ld(page).map((item) => item["@type"]);

test("structured data names the organisation, the datasets and their status", () => {
  for (const language of ["en", "zh-CN"]) {
    assert.deepEqual(types(html(language, "")).sort(), ["Organization", "WebSite"]);
    assert.ok(types(html(language, "/whitepaper")).includes("Article"));
    const org = ld(html(language, "")).find((item) => item["@type"] === "Organization");
    assert.deepEqual(org.sameAs, ["https://x.com/surviagi", "https://discord.gg/ArVHw2K9X", "https://github.com/feyn-machines/surviagi"]);
  }
});

test("a dataset states that it is machine-proposed and when it was produced", { skip: !HAS_SNAPSHOT }, () => {
  for (const path of ["/markets", "/occupations"]) {
    const dataset = ld(html("en", path)).find((item) => item["@type"] === "Dataset");
    assert.ok(dataset, path);
    assert.match(dataset.creativeWorkStatus, /machine-proposed/i);
    assert.ok(dataset.dateModified && dataset.version);
  }
});

test("structured data never claims a review or a rating", () => {
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      for (const type of types(html(language, path))) {
        assert.ok(!["ClaimReview", "Rating", "AggregateRating", "Review"].includes(type), `${language}${path}: ${type}`);
      }
    }
  }
});

test("llms.txt is generated from the site, names real pages, and overstates nothing", async () => {
  const text = body("llms.txt");
  assert.match(text, /^# SurviAGI\n/);
  assert.doesNotMatch(text, /\bplatform\b|verified|reviewed score|replacement rate/i);
  if (HAS_SNAPSHOT) assert.match(text, /machine-proposed/i);
  else assert.match(text, /No data snapshot is published in this build\./);
  assert.match(text, /https:\/\/x\.com\/surviagi/);
  assert.match(text, /https:\/\/discord\.gg\/ArVHw2K9X/);
  assert.match(text, /https:\/\/github\.com\/feyn-machines\/surviagi/);
  if (HAS_SNAPSHOT) {
    // One dated sentence an engine can quote, with the numbers the home page shows, then the work furthest along.
    const manifest = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "manifest.json"), "utf8"));
    const said = text.match(/^As of (\d{4}-\d{2}-\d{2}), AI updates have given a level to (\d+) of the (\d+) kinds of work .*? (\d+) updates from (\d+) AI companies/m);
    assert.ok(said, "llms.txt has no dated answer sentence");
    assert.equal(said[1], manifest.generated_at.slice(0, 10));
    const home = html("en", "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const [n, label] of [[said[2], "Kinds of work reached"], [said[5], "AI companies tracked"]]) {
      assert.ok(home.includes(`${n} ${label}`), `llms.txt says ${n} where the home page does not say "${n} ${label}"`);
    }
    assert.match(text, /^### At L\d\n\n- \[[^\]]+\]\(https:\/\/surviagi\.com\/work\//m);
    // Each level says what it means and what evidence it needs, in the home page's words.
    const homeHtml = html("en", "");
    for (const line of text.match(/^- L[0-5] .+$/gm) ?? []) {
      const roles = line.replace(/^- L\d [^:]+: /, "").replace(/ Evidence required: .*$/, "");
      assert.ok(homeHtml.includes(roles), `llms.txt says "${roles}", the home page does not`);
    }
    assert.equal((text.match(/^- L[0-5] .+$/gm) ?? []).length, 6, "llms.txt does not define all six levels");
  }
  for (const [, url] of text.matchAll(/\]\((https:\/\/surviagi\.com[^)]*)\)/g)) {
    const path = url.slice(SITE.length).replace(/\/$/, "");
    if (/\.(txt|xml)$/.test(path)) continue;
    assert.equal((await fetch(`${site.base}${path || "/"}`)).status, 200, `${url} is not a page`);
  }
});

test("the home page's count of recent updates covers only the last 30 days of the window", { skip: !HAS_SNAPSHOT }, () => {
  const chain = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "chain.json"), "utf8"));
  const coverage = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "coverage.json"), "utf8"));
  const levelled = new Set(chain.activities.filter((a) => a.evidence_rows && a.level).map((a) => a.activity_id));
  const used = new Set(chain.evidence.filter((r) => r.level != null && r.observed_level != null && levelled.has(r.activity_id)).map((r) => r.event_id));
  const last = Date.parse(coverage.collection_window.last.slice(0, 10));
  const day = 24 * 60 * 60 * 1000;
  const recent = chain.events.filter((e) => used.has(e.event_id) && e.occurred_at && last - Date.parse(e.occurred_at.slice(0, 10)) < 30 * day).length;
  for (const [language, label] of [["en", "AI updates in 30 days"], ["zh-CN", "30 天内的 AI 更新"]]) {
    const text = html(language, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const shown = text.match(new RegExp(`(\\d+) ${label}`))?.[1];
    assert.equal(Number(shown), recent, `${language}: the home page says ${shown} ${label}`);
  }
});

test("the figures on the home page are in its HTML, not only drawn by script", { skip: !HAS_SNAPSHOT }, () => {
  for (const language of ["en", "zh-CN"]) {
    const text = html(language, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    assert.match(text, /\bL[0-5]\b/, `${language}: no level appears as text`);
    assert.ok((text.match(/\d{2,}/g) ?? []).length >= 5, `${language}: fewer than five numbers appear as text`);
  }
});

/** The local PostgreSQL of the data pipeline, when it is running and holds an active release; null otherwise. */
async function localDatabase() {
  const passwordFile = join(ROOT, "data", "postgres", "password");
  if (!existsSync(passwordFile)) return null;
  const password = readFileSync(passwordFile, "utf8").trim();
  const url = `postgres://openaiwill:${encodeURIComponent(password)}@127.0.0.1:7543/openaiwill_local`;
  const { Client } = createRequire(import.meta.url)("pg");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    const { rows } = await client.query("SELECT release_id FROM kg.active");
    return rows[0] ? { url, releaseId: rows[0].release_id } : null;
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
}

test("with a database, the server serves the active release", async (t) => {
  const database = await localDatabase();
  if (!database) return t.skip("no local PostgreSQL with an active data release");
  const { base, proc } = await startServer({ DATABASE_URL: database.url });
  try {
    const { data } = await (await fetch(`${base}/healthz`)).json();
    assert.equal(data.source, "database");
    assert.equal(data.releaseId, database.releaseId);
    assert.equal((await fetch(`${base}/markets`)).status, 200);
    assert.equal((await fetch(`${base}/markets/no-such-market`)).status, 404);
  } finally {
    await stop(proc);
  }
});

test("a server that cannot reach its database does not stay up", { timeout: 60000 }, async () => {
  const dir = assemble();
  const port = await freePort();
  const proc = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: { ...process.env, DATABASE_URL: "postgres://nobody:none@127.0.0.1:1/none", PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  running.push(proc);
  let log = "";
  proc.stderr.on("data", (chunk) => (log += chunk));
  // Five attempts two seconds apart, then it gives up.
  const code = await exitsWithin(proc, 40000);
  assert.notEqual(code, 0);
  assert.match(log, /load attempt 1\/5 failed/);
  assert.match(log, /cannot load the data release/);
});

test("a server that must use the database exits when none is configured", { timeout: 30000 }, async () => {
  const dir = assemble();
  const port = await freePort();
  const env = { ...process.env, SITE_REQUIRE_DATABASE: "1", PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production" };
  delete env.DATABASE_URL;
  const proc = spawn(process.execPath, ["server.js"], { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"] });
  running.push(proc);
  let log = "";
  proc.stderr.on("data", (chunk) => (log += chunk));
  assert.notEqual(await exitsWithin(proc, 20000), 0);
  assert.match(log, /SITE_REQUIRE_DATABASE is on but DATABASE_URL is not set/);
});

test("a server that must use the database is healthy only when it serves a release from it", async (t) => {
  const database = await localDatabase();
  if (!database) return t.skip("no local PostgreSQL with an active data release");
  const { base, proc } = await startServer({ DATABASE_URL: database.url, SITE_REQUIRE_DATABASE: "1" });
  try {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.source, "database");
  } finally {
    await stop(proc);
  }
});

test("on a phone the updates table is a list of cards, not a frame that cuts titles off", async () => {
  // 2026-10-16: at 390px the 860px table showed each title cut mid-word and hid the publisher and level.
  const html = pages.get("zh-CN/updates");
  const sheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);
  assert.ok(sheets.length > 0, "the updates page links a stylesheet");
  let css = "";
  for (const href of sheets) css += await (await fetch(new URL(href, site.base))).text();
  const phone = [...css.matchAll(/@media \(max-width:\s*720px\)\s*\{([\s\S]*?)\}\s*\}/g)].map((m) => m[1]).join("\n");
  assert.match(phone, /grid-template-areas:\s*"when from"\s*"update update"\s*"landed top"/);
  // Outranks the global .oaw-table minimum whatever order the sheets load in: two classes, not one.
  assert.match(phone, /\.[\w-]*tableWrap[\w-]* \.[\w-]*table[\w-]*\{min-width:0\}/);
});
