import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assemble, cleanup, exitsWithin, freePort, running, startServer, stop } from "./site-server.mjs";

// These tests start the built server (`pnpm build` first) and read what it answers over HTTP.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STANDALONE = join(ROOT, ".next", "standalone");
// SNAPSHOT_DIR lets the same checks run against a snapshot written by a newer publisher.
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR ?? join(ROOT, "datasets", "published", "latest");
const HAS_SNAPSHOT = existsSync(join(SNAPSHOT_DIR, "manifest.json"));
const LEGAL = ["/privacy", "/terms"];
const FIXED = ["", "/markets", "/occupations", "/topics", "/updates", "/voices", "/articles", "/whitepaper", "/agents", ...LEGAL];

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

test("the language switch asks crawlers not to follow its redirecting ?lang= links", () => {
  for (const language of ["en", "zh-CN"]) {
    for (const path of FIXED) {
      const links = [...html(language, path).matchAll(/<a\b[^>]*\shref="\?lang=[^"]*"[^>]*>/g)].map((m) => m[0]);
      assert.equal(links.length, 2, `${language}${path}: expected the two language options`);
      for (const link of links) assert.match(link, /\srel="nofollow"/, `${language}${path}: ${link}`);
    }
  }
});

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
      // Installation archives are shared binary downloads, with no page language.
      if (/^\/api\/agent\/packages\/(surviagi|surviagi-http|surviagi-submit)\.zip$/.test(link)) continue;
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
  for (const section of ["markets", "occupations/g", "occupations", "updates"]) {
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
  for (const section of ["/markets/", "/occupations/", "/occupations/g/", "/topics/"]) {
    // Sitemap occupations have evidence; a market with none is a dead end the sentence must still answer.
    const path = locs.find((l) => l.startsWith(section) && (section === "/occupations/g/" || !l.startsWith("/occupations/g/")));
    assert.ok(path, `no ${section} page in the sitemap`);
    for (const [language, prefix] of [["en", ""], ["zh-CN", "/zh-CN"]]) {
      const page = await (await fetch(`${site.base}${prefix}${path}`)).text();
      const title = page.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1];
      const sentence = page.match(new RegExp(`<p[^>]*>(${opening[language]}[^<]+)</p>`))?.[1];
      assert.ok(sentence, `${language}${path}: no dated answer`);
      // A topic's title is its question; the sentence counts who argues, so it does not repeat it.
      if (section !== "/topics/") assert.ok(title && sentence.includes(title), `${language}${path}: the answer does not name ${title}`);
      assert.ok(!/\{\w+\}/.test(sentence), `${language}${path}: unfilled placeholder in ${sentence}`);
    }
  }
});

test("market, occupation and topic pages name a Markdown copy that says what the page says", { skip: !HAS_SNAPSHOT }, async () => {
  const locs = [...files.get("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  const text = (page) => page.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');
  for (const section of ["/markets/", "/occupations/", "/topics/"]) {
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
  for (const missing of ["/work/no-such-work/raw.md", "/work/no-such-work", "/markets/no-such-market/raw.md", "/occupations/00-0000.00/raw.md", "/topics/no-such-topic/raw.md"]) {
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

test("announcement chronology reaches lists, timelines, market pages and sitemap without inventing an occurrence", { skip: !HAS_SNAPSHOT, timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "surviagi-announced-"));
  cpSync(SNAPSHOT_DIR, dir, { recursive: true });
  const chain = JSON.parse(readFileSync(join(dir, "chain.json"), "utf8"));
  const events = JSON.parse(readFileSync(join(dir, "events.json"), "utf8"));
  // An update the sitemap lists, on a market that has a page.
  const offered = new Set(events.filter(substantial).map((e) => e.event_id));
  const reading = chain.evidence.find((r) => offered.has(r.event_id) && r.level != null && r.observed_level != null);
  const activity = chain.activities.find((a) => a.activity_id === reading.activity_id);
  const event = chain.events.find((e) => e.event_id === reading.event_id);
  // Later than every occurrence AND the collection window, so the timeline must extend too.
  const coverage = JSON.parse(readFileSync(join(dir, "coverage.json"), "utf8"));
  const latest = Math.max(Date.parse(coverage.collection_window.last), ...chain.events.map((e) => Date.parse(e.occurred_at ?? e.announced_at ?? "")).filter(Number.isFinite));
  const day = new Date(latest + 86400000).toISOString().slice(0, 10);
  const announced = `${day}T09:00:00+00:00`;
  for (const row of [event, events.find((e) => e.event_id === event.event_id)]) {
    Object.assign(row, { occurred_at: null, announced_at: announced });
  }
  writeFileSync(join(dir, "chain.json"), JSON.stringify(chain));
  writeFileSync(join(dir, "events.json"), JSON.stringify(events));
  const { base, proc } = await startServer({ SNAPSHOT_DIR: dir });
  try {
    for (const [prefix, line] of [["", `Announced ${day}`], ["/zh-CN", `${day} 宣布`]]) {
      const page = await (await fetch(`${base}${prefix}/updates/${event.event_id}`)).text();
      assert.ok(page.includes(line), `${prefix}: no announcement label`);
      const ld = [...page.matchAll(/<script type="application\/ld\+json"[^>]*>([^<]+)<\/script>/g)].flatMap((m) => [JSON.parse(m[1])].flat());
      assert.ok(ld.some((d) => d["@type"] === "Article" && d.datePublished === announced));
      const md = await (await fetch(`${base}${prefix}/updates/${event.event_id}/raw.md`)).text();
      assert.ok(md.includes(line));
      const list = await (await fetch(`${base}${prefix}/updates`)).text();
      const first = list.match(/<tbody[^>]*>\s*(<tr[\s\S]*?<\/tr>)/)?.[1];
      assert.ok(first?.includes(event.event_id), `${prefix}: the latest announcement is absent from the first row`);
      assert.ok(first.includes(line));
      const home = await (await fetch(`${base}${prefix || "/"}`)).text();
      const timeline = home.match(/<section id="updates"[\s\S]*?<\/section>/)?.[0];
      assert.ok(timeline?.includes(event.event_id), `${prefix}: announcement is absent from the latest timeline day`);
      assert.ok(timeline.includes(line));
      assert.ok(home.includes(day));
      const marketPath = `/markets/${activity.market_id.replace(/^oaw:market:/, "")}`;
      for (const suffix of ["", "/raw.md"]) {
        const market = await (await fetch(`${base}${prefix}${marketPath}${suffix}`)).text();
        assert.ok(market.includes(line), `${prefix}${marketPath}${suffix}: no announcement label`);
      }
    }
    const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
    const entry = [...sitemap.matchAll(/<url>[\s\S]*?<\/url>/g)].map((m) => m[0]).find((x) => x.includes(`/updates/${event.event_id}</loc>`));
    assert.ok(entry?.includes(`<lastmod>${announced}</lastmod>`), "sitemap lost the source announcement");
  } finally {
    await stop(proc);
    rmSync(dir, { recursive: true, force: true });
  }
});

// The inclusion rule of Issue #36, written out again from the published files rather than imported from the site.
const substantial = (e) =>
  (e.facts?.length ?? 0) > 0 || Boolean(e.task && e.result && e.result !== "not_stated") || e.source_count >= 2;

test("the sitemap offers only pages with something of their own; the others answer but ask not to be indexed", { skip: !HAS_SNAPSHOT, timeout: 60000 }, async () => {
  const read = (name) => JSON.parse(readFileSync(join(SNAPSHOT_DIR, `${name}.json`), "utf8"));
  const events = read("events");
  const topics = read("topics");
  const paths = new Set([...files.get("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname));
  const listed = (prefix) => [...paths].filter((p) => p.startsWith(prefix) && !p.startsWith("/occupations/g/")).map((p) => p.slice(prefix.length)).sort();

  // Updates: only those with an update page (it bears on some work) that state a figure, a task with its result,
  // or have two sources. A release before Issue #35 links updates to work in its graded chain instead.
  const withPage = new Set(events.some((e) => e.work)
    ? events.filter((e) => e.work?.length).map((e) => e.event_id)
    : read("chain").evidence.map((r) => r.event_id));
  const wantUpdates = events.filter((e) => withPage.has(e.event_id) && substantial(e)).map((e) => e.event_id).sort();
  assert.ok(wantUpdates.length > 0 && wantUpdates.length < withPage.size, "the update threshold separates nothing in this release");
  assert.deepEqual(listed("/updates/"), wantUpdates);
  assert.ok(!listed("/zh-CN/updates/").length, "a Chinese update address is in the sitemap");

  // Topics argued by at least two accounts, in both languages.
  const wantTopics = topics.filter((t) => t.accounts >= 2).map((t) => t.slug).sort();
  assert.ok(wantTopics.length > 0 && wantTopics.length < topics.length, "the topic threshold separates nothing in this release");
  assert.deepEqual(listed("/topics/"), wantTopics);
  assert.deepEqual(listed("/zh-CN/topics/"), wantTopics);

  // Markets some update bears on, when the release links updates to work directly.
  if (events.some((e) => e.work)) {
    const marketOf = new Map(read("work").map((w) => [w.id, w.market_id]));
    const wantMarkets = [...new Set(events.flatMap((e) => (e.work ?? []).map((w) => marketOf.get(w.activity_id))).filter(Boolean))]
      .map((id) => id.replace(/^oaw:market:/, "")).sort();
    assert.deepEqual(listed("/markets/"), wantMarkets);
    assert.deepEqual(listed("/zh-CN/markets/"), wantMarkets);
  }

  // One page each side of the update and topic thresholds: below it the page asks not to be indexed.
  const noindex = (page) => /<meta name="robots" content="noindex, follow"\/>/.test(page);
  const below = {
    update: events.find((e) => withPage.has(e.event_id) && !substantial(e)).event_id,
    topic: topics.find((t) => t.accounts < 2).slug,
  };
  for (const [path, offeredPage] of [
    [`/updates/${wantUpdates[0]}`, true], [`/updates/${below.update}`, false],
    [`/topics/${wantTopics[0]}`, true], [`/topics/${below.topic}`, false],
  ]) {
    const res = await fetch(`${site.base}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(noindex(await res.text()), !offeredPage, `${path}: robots`);
    // The Markdown copy follows the same rule, but this preview server marks every response noindex, so its header
    // cannot tell the two apart here.
  }
});

test("an update page shows the figures, task and basis that earn it a place in the sitemap", { skip: !HAS_SNAPSHOT }, async () => {
  const events = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "events.json"), "utf8"));
  const paths = [...files.get("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  const listed = new Set(paths.filter((p) => p.startsWith("/updates/")).map((p) => p.slice("/updates/".length)));
  const event = events.find((e) => listed.has(e.event_id) && e.facts?.length && e.task && e.basis);
  assert.ok(event, "no listed update with a figure, a task and a basis");
  for (const [prefix, heading] of [["", "What it reports"], ["/zh-CN", "它报告了什么"]]) {
    const page = await (await fetch(`${site.base}${prefix}/updates/${event.event_id}`)).text();
    const md = await (await fetch(`${site.base}${prefix}/updates/${event.event_id}/raw.md`)).text();
    const escaped = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    assert.ok(page.includes(heading) && md.includes(`## ${heading}`), `${prefix}: no ${heading}`);
    for (const text of [event.task, event.facts[0].what]) {
      assert.ok(page.includes(escaped(text)), `${prefix}: the page lacks ${text}`);
      assert.ok(md.includes(text), `${prefix}: the Markdown copy lacks ${text}`);
    }
    // A quote that reached us HTML-escaped is shown as the post shows it, not escaped twice.
    const quote = event.facts[0].quote.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    assert.ok(md.includes(quote), `${prefix}: the Markdown copy lacks the quote ${quote}`);
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

// The fragment a market page gives each kind of work; the same rule as src/lib/anchors.ts.
const anchorOf = (work) => `a-${work.activity_id.startsWith(`${work.market_id}-`) ? work.activity_id.slice(work.market_id.length + 1) : work.activity_id.replace(/^oaw:market:/, "")}`;

test("a kind of work has no page of its own: its old address moves permanently to its row on the market page", { skip: !HAS_SNAPSHOT }, async () => {
  const chain = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "chain.json"), "utf8"));
  const work = chain.activities.find((a) => a.evidence_rows);
  assert.ok(work, "no work with an update");
  const slug = work.activity_id.replace(/^oaw:market:/, "");
  const market = `/markets/${work.market_id.replace(/^oaw:market:/, "")}`;
  for (const prefix of ["", "/zh-CN"]) {
    const page = await fetch(`${site.base}${prefix}/work/${slug}`, { redirect: "manual" });
    assert.equal(page.status, 301, `${prefix}/work/${slug}`);
    assert.equal(page.headers.get("location"), `${prefix}${market}#${anchorOf(work)}`);
    const copy = await fetch(`${site.base}${prefix}/work/${slug}/raw.md`, { redirect: "manual" });
    assert.equal(copy.status, 301);
    assert.equal(copy.headers.get("location"), `${prefix}${market}/raw.md`);
  }
  // Nothing in the sitemap points at the old address.
  assert.ok(!/<loc>[^<]*\/work\//.test(body("sitemap.xml")), "the sitemap still lists a /work/ address");
});

test("a market page lists the updates that bear on each kind of work, and the posts that also say so, and ranks nothing", { skip: !HAS_SNAPSHOT }, async () => {
  const chain = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "chain.json"), "utf8"));
  const confirmed = chain.evidence.find((row) => row.confirmations?.length);
  if (!confirmed) return;
  const [first] = confirmed.confirmations;
  const work = chain.activities.find((a) => a.activity_id === confirmed.activity_id);
  const path = `/markets/${work.market_id.replace(/^oaw:market:/, "")}`;
  const page = await (await fetch(`${site.base}${path}`)).text();
  assert.ok(page.includes(`href="${first.url}"`), `${path} does not link the post that also says so`);
  assert.ok(page.includes(`id="${anchorOf(work)}"`), `${path} has no row for the work`);
  const md = await (await fetch(`${site.base}/zh-CN${path}/raw.md`)).text();
  assert.ok(md.includes(`](${first.url})`), `${path}/raw.md does not link the post that also says so`);
  assert.ok(md.includes("也这么说"), `${path}/raw.md does not say it`);
  for (const [prefix, text] of [["", page], ["/zh-CN", await (await fetch(`${site.base}/zh-CN${path}`)).text()]]) {
    assert.ok(!/>L[0-5]</.test(text), `${prefix}${path} still shows a level`);
  }
  assert.ok(!/\bL[0-5]\b/.test(md), `${path}/raw.md still shows a level`);
});

test("document-backed pages stay static while live editorial pages render per request", () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name === "page.tsx" ? [join(dir, entry.name)] : []);
  for (const file of walk(join(ROOT, "src", "app", "[lang]"))) {
    const text = readFileSync(file, "utf8");
    // The whitepaper and existing Markdown article details are built from source documents.
    // The article listing and editorial preview/approved routes read live database pointers.
    // The legal pages read nothing, but the layout's sign-in menu depends on the server's settings, so they
    // render per request too.
    if (/[\\/]whitepaper[\\/]/.test(file) || /[\\/]articles[\\/]\[slug\][\\/]page\.tsx$/.test(file)) assert.match(text, /export const dynamic = "force-static"/, file);
    else assert.match(text, /export const dynamic = "force-dynamic"/, file);
  }
});

test("every market in the loaded data belongs to a market group the market list can draw", { skip: !HAS_SNAPSHOT }, () => {
  const chain = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "chain.json"), "utf8"));
  const stored = JSON.parse(readFileSync(join(ROOT, "src", "content", "market-groups.json"), "utf8"));
  const markets = new Set(chain.activities.map((a) => a.market_id));
  assert.ok(markets.size > 0);
  const ungrouped = [...markets].filter((id) => !stored.groups[stored.group_of_market[id]]);
  assert.deepEqual(ungrouped, [], "markets with no group cannot be listed under a domain");
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
  assert.equal(groups.length, 16);
  for (const group of groups) {
    assert.match(group, /^Allow: \/$/m, group);
    for (const path of ["/admin", "/zh-CN/admin", "/api/"]) assert.match(group, new RegExp(`^Disallow: ${path}$`, "m"), `${path} in ${group}`);
    assert.deepEqual([...group.matchAll(/^Disallow: (.*)$/gm)].map((m) => m[1]).sort(), ["/admin", "/api/", "/zh-CN/admin"]);
  }
  for (const bot of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User",
    "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot", "Bytespider",
    "Amazonbot", "meta-externalagent", "DuckAssistBot"]) {
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
  const occurred = new Map(events.map((e) => [e.event_id, e.occurred_at ?? e.announced_at]));
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
  // Since Issue #36 a detail page is listed only with evidence of its own, so an undated one is rare; when there is
  // one, the loop above has checked that it carries no lastmod.
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
    // One dated sentence an engine can quote, with the numbers the home page shows. The level scale is retired (#35).
    const manifest = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "manifest.json"), "utf8"));
    const said = text.match(/^As of (\d{4}-\d{2}-\d{2}), (\d+) updates from (\d+) AI companies have been collected since /m);
    assert.ok(said, "llms.txt has no dated answer sentence");
    assert.equal(said[1], manifest.generated_at.slice(0, 10));
    const home = html("en", "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.ok(home.includes(`${said[2]} updates from ${said[3]} AI companies`), `llms.txt says ${said[2]} updates from ${said[3]} companies where the home page does not`);
    assert.doesNotMatch(text, /^## Levels/m, "llms.txt still defines the retired levels");
    assert.doesNotMatch(text, /^- L[0-5] /m);
    assert.doesNotMatch(text, /\bL[0-5]\b(?!–L5)/, "llms.txt presents a level as a conclusion");
  }
  for (const [, url] of text.matchAll(/\]\((https:\/\/surviagi\.com[^)]*)\)/g)) {
    const path = url.slice(SITE.length).replace(/\/$/, "");
    if (/\.(txt|xml)$/.test(path)) continue;
    assert.equal((await fetch(`${site.base}${path || "/"}`)).status, 200, `${url} is not a page`);
  }
});

test("the home page's counts cover the updates published, and its recent count only the last 30 days of the window", { skip: !HAS_SNAPSHOT }, () => {
  const events = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "events.json"), "utf8"));
  const coverage = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "coverage.json"), "utf8"));
  const stamp = (e) => (e.occurred_at ?? e.announced_at ?? "").slice(0, 10);
  const last = Math.max(Date.parse(coverage.collection_window.last.slice(0, 10)), ...events.map((e) => Date.parse(stamp(e))).filter(Number.isFinite));
  const day = 24 * 60 * 60 * 1000;
  const recent = events.filter((e) => stamp(e) && last - Date.parse(stamp(e)) < 30 * day).length;
  for (const [language, pattern] of [
    ["en", /(\d+) updates from \d+ AI companies collected since [\d-]+; (\d+) in the last 30 days/],
    ["zh-CN", /收集了 \d+ 家 AI 公司的 (\d+) 条更新，近 30 天有 (\d+) 条/],
  ]) {
    const text = html(language, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const shown = text.match(pattern);
    assert.ok(shown, `${language}: the home page has no standing sentence`);
    assert.equal(Number(shown[1]), events.length, `${language}: the home page counts ${shown[1]} updates`);
    assert.equal(Number(shown[2]), recent, `${language}: the home page counts ${shown[2]} recent updates`);
  }
});

test("the home page is the question entry: both search forms, the four sections, and no level", { skip: !HAS_SNAPSHOT }, () => {
  for (const [language, prefix] of [["en", ""], ["zh-CN", "/zh-CN"]]) {
    const page = html(language, "");
    for (const target of ["/occupations", "/markets"]) {
      assert.match(page, new RegExp(`<form[^>]*action="${prefix}${target}"`), `${language}: no search form to ${target}`);
    }
    for (const target of ["/markets", "/occupations", "/topics", "/articles", "/updates"]) {
      assert.ok(page.includes(`href="${prefix}${target}"`), `${language}: no link to ${target}`);
    }
    const text = page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(text, /\bL[0-5]\b/, `${language}: a level appears on the home page`);
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
  // 2026-10-16: at 390px the 860px table showed each title cut mid-word and hid the publisher and the reach.
  const html = pages.get("zh-CN/updates");
  const sheets = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);
  assert.ok(sheets.length > 0, "the updates page links a stylesheet");
  let css = "";
  for (const href of sheets) css += await (await fetch(new URL(href, site.base))).text();
  const phone = [...css.matchAll(/@media \(max-width:\s*720px\)\s*\{([\s\S]*?)\}\s*\}/g)].map((m) => m[1]).join("\n");
  assert.match(phone, /grid-template-areas:\s*"when from"\s*"update update"\s*"landed landed"/);
  // Outranks the global .oaw-table minimum whatever order the sheets load in: two classes, not one.
  assert.match(phone, /\.[\w-]*tableWrap[\w-]* \.[\w-]*table[\w-]*\{min-width:0\}/);
});

// ------------------------------------------------------------ agent access (Issue #5) ----

const rpc = async (path, message, headers = {}) => {
  const res = await fetch(`${site.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof message === "string" ? message : JSON.stringify(message),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};
const tool = async (name, args, path = "/api/mcp") =>
  (await rpc(path, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).body.result;

test("MCP: a client initializes with no key, and the public endpoint lists only the read tools", async () => {
  const init = await rpc("/api/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
  assert.match(init.body.result.instructions, /machine-proposed/);
  assert.match(init.headers.get("cache-control") ?? "", /no-store/);
  // An unknown version asked for is answered with the server's own.
  const old = await rpc("/api/mcp", { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(old.body.result.protocolVersion, "2025-06-18");
  assert.equal((await rpc("/api/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const tools = (await rpc("/api/mcp", { jsonrpc: "2.0", id: 3, method: "tools/list" })).body.result.tools;
  assert.deepEqual(tools.map((t) => t.name), ["search", "get_record", "query_observations", "occupation_summary", "changes_since"]);
  assert.deepEqual(tools[0].inputSchema.properties.types.items.enum, ["update", "question", "observation", "evidence", "article"]);
  assert.deepEqual(tools[0].inputSchema.properties.status.enum, ["approved", "preview"]);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.inputSchema.type, "object");
  }
  const call = await rpc("/api/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "submit_question", arguments: {} } });
  assert.equal(call.body.error.code, -32602);
  assert.match(call.body.error.message, /api\/mcp\/submit/);
  assert.equal((await rpc("/api/mcp", { jsonrpc: "2.0", id: 5, method: "ping" })).body.result && true, true);
  assert.equal((await rpc("/api/mcp", { jsonrpc: "2.0", id: 6, method: "resources/list" })).body.error.code, -32601);
});

test("MCP: the transport's edges: GET is 405; a batch, a bad body and an unknown protocol header are refused; no CORS", async () => {
  const get = await fetch(`${site.base}/api/mcp`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await rpc("/api/mcp", [{ jsonrpc: "2.0", id: 1, method: "ping" }])).status, 400);
  assert.equal((await rpc("/api/mcp", "{not json")).body.error.code, -32700);
  assert.equal((await rpc("/api/mcp", { id: 1, method: "ping" })).status, 400);
  // A client's own Origin is no reason to refuse (no cookie is ever used), and no CORS header lets a page read the answer.
  const foreign = await rpc("/api/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "app://workbuddy" });
  assert.equal(foreign.status, 200);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${site.base}/api/mcp`, { method: "OPTIONS" })).headers.get("access-control-allow-origin"), null);
  assert.equal((await rpc("/api/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2099-01-01" })).status, 400);
  assert.equal((await rpc("/api/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2025-06-18" })).status, 200);
  assert.equal((await rpc("/api/mcp", "x".repeat(70 * 1024))).status, 400);
});

test("MCP: search answers with structured, cited records of the loaded release; get_record reads each kind", { skip: !HAS_SNAPSHOT }, async () => {
  const manifest = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "manifest.json"), "utf8"));
  const chain = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "chain.json"), "utf8"));
  const topics = JSON.parse(readFileSync(join(SNAPSHOT_DIR, "topics.json"), "utf8"));
  const update = chain.events.find((e) => e.org_name && e.title.split(" ").length > 3);
  const word = update.org_name;
  const result = await tool("search", { query: word, limit: 5 });
  assert.equal(result.isError, undefined);
  const found = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), found, "the text content is the same JSON");
  assert.ok(found.results.length > 0 && found.results.length <= 5);
  assert.equal(found.release.generated_at, manifest.generated_at);
  const ids = new Set([...chain.events.map((e) => e.event_id), ...topics.map((t) => t.topic_id)]);
  for (const r of found.results) {
    // Evidence readings carry the retired level scale: they are returned only when asked for by name (#35).
    assert.ok(["update", "question"].includes(r.type), `${r.type} is not a default search type`);
    assert.equal(r.review, "machine_proposed_unreviewed");
    assert.ok(Object.keys(found.content_kinds).includes(r.content));
    assert.ok(r.url.startsWith("https://surviagi.com/"));
    if (r.type !== "evidence") assert.ok(ids.has(r.id), `${r.id} is a published record`);
    assert.ok([...r.snippet].length <= 280);
  }
  // Each kind of record reads back, and says that the source text is not here.
  const question = topics.find((t) => t.claims.some((c) => c.quote));
  const evidenceRow = chain.evidence[0];
  const slug = evidenceRow.activity_id.replace(/^oaw:market:/, "");
  for (const id of [update.event_id, question.topic_id, `evidence:${evidenceRow.event_id}:${slug}`]) {
    const read = await tool("get_record", { id });
    assert.equal(read.isError, undefined, id);
    const record = read.structuredContent;
    assert.equal(record.id, id);
    if (record.type === "evidence") assert.match(record.deprecated.reason, /retired/, "an evidence reading says it is deprecated");
    assert.equal(record.original_text.available, false);
    assert.equal(record.release.generated_at, manifest.generated_at);
    const page = await fetch(`${site.base}${record.url.slice("https://surviagi.com".length)}`);
    assert.equal(page.status, 200, `${record.url} is a page`);
  }
  const q = (await tool("get_record", { id: question.topic_id })).structuredContent;
  const quoted = q.claims.find((c) => c.quote);
  assert.equal(quoted.quote_content, "post_quote");
  assert.equal(quoted.says_content, "machine_summary");
  // Chinese works too, and points at Chinese pages.
  const zh = (await tool("search", { query: question.question["zh-CN"], types: ["question"], language: "zh-CN" })).structuredContent;
  assert.equal(zh.results[0].id, question.topic_id);
  assert.ok(zh.results[0].url.startsWith("https://surviagi.com/zh-CN/topics/"));
});

test("MCP: bad arguments and unknown ids are tool errors the agent can read, and a miss starts nothing", async () => {
  for (const args of [{}, { query: "" }, { query: "x".repeat(201) }, { query: "a", limit: 50 }, { query: "a", types: ["posts"] }, { query: "a", from: "yesterday" }, { query: "a", language: "fr" }]) {
    const result = await tool("search", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(result.structuredContent.error, "invalid");
  }
  assert.equal((await tool("get_record", { id: "../../etc/passwd" })).structuredContent.error, "invalid");
  assert.equal((await tool("get_record", { id: `ev-${"0".repeat(40)}` })).structuredContent.error, "not_found");
  const none = (await tool("search", { query: "zzqqxxnonexistentterm" })).structuredContent;
  assert.deepEqual(none.results, []);
  assert.match(none.note, /starts no research or collection/);
});

test("MCP submit endpoint without the user database: reading works, submitting is unavailable", async () => {
  const tools = (await rpc("/api/mcp/submit", { jsonrpc: "2.0", id: 1, method: "tools/list" })).body.result.tools;
  assert.equal(tools.length, 8);
  assert.equal((await tool("search", { query: "model" }, "/api/mcp/submit")).isError, undefined);
  const refused = await tool("submit_question", { question: "x" }, "/api/mcp/submit");
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error, "unavailable");
});

test("HTTP: search and record are public and cacheable for a minute; submitting without the user database is 503", async () => {
  const res = await fetch(`${site.base}/api/agent/search?q=model&types=update&types=evidence&limit=3`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  const body = await res.json();
  assert.ok(body.results.every((r) => r.type === "update" || r.type === "evidence"));
  assert.equal((await fetch(`${site.base}/api/agent/search?query=a&limit=0`)).status, 400);
  assert.equal((await fetch(`${site.base}/api/agent/record?id=nope`)).status, 400);
  const post = await fetch(`${site.base}/api/agent/questions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(post.status, 503);
  assert.match(post.headers.get("cache-control") ?? "", /no-store/);
});

test("anonymous reading is limited per client address, and one address does not use up another's", async () => {
  const from = (ip) => fetch(`${site.base}/api/agent/search?query=model&limit=1`, { headers: { "cf-connecting-ip": ip } });
  let last;
  for (let n = 0; n < 60; n += 1) last = await from("198.51.100.7");
  assert.equal(last.status, 200);
  const over = await from("198.51.100.7");
  assert.equal(over.status, 429);
  assert.equal(over.headers.get("retry-after"), "60");
  assert.equal((await rpc("/api/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { "cf-connecting-ip": "198.51.100.7" })).status, 429, "MCP shares the budget");
  assert.equal((await from("198.51.100.8")).status, 200);
});

test("the agents page says what is open, what needs a key and the limits the code enforces, in both languages", () => {
  const en = html("en", "/agents");
  for (const text of ["https://surviagi.com/api/mcp", "https://surviagi.com/api/mcp/submit", "Authorization: Bearer", "/api/agent/search", "submit_question", "A preview is public", "article:", "60 requests a minute", 'id="keys"']) {
    assert.ok(en.includes(text), text);
  }
  assert.ok(html("zh-CN", "/agents").includes("接入 AI 助手"));
  for (const language of ["en", "zh-CN"]) {
    const page = html(language, "");
    assert.ok(page.includes(`href="${language === "en" ? "" : "/zh-CN"}/agents"`), `${language} footer links to the agents page`);
  }
  assert.match(body("llms.txt"), /https:\/\/surviagi\.com\/api\/mcp\b/);
});

test("the HTTP Skill's script reads without a key and refuses to submit without one", { skip: !HAS_SNAPSHOT }, async () => {
  const script = join(ROOT, "integrations", "workbuddy", "skill-http", "surviagi-http", "scripts", "surviagi.py");
  const run = (args, env = {}) =>
    new Promise((resolve) => {
      const child = spawn("python3", ["-I", script, ...args], { env: { PATH: process.env.PATH, SURVIAGI_BASE_URL: site.base, ...env } });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("exit", (code) => resolve({ code, out }));
    });
  const found = await run(["search", "model", "--limit", "2", "--types", "update"]);
  assert.equal(found.code, 0);
  const body = JSON.parse(found.out);
  assert.ok(body.results.length > 0 && body.results.every((r) => r.type === "update"));
  const read = await run(["record", body.results[0].id]);
  assert.equal(JSON.parse(read.out).id, body.results[0].id);
  const refused = await run(["question", "--question", "Will AI replace X soon?", "--why", "w".repeat(20), "--gap", "g".repeat(10)]);
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error, "missing_key");
});

test("the WorkBuddy packages assemble in the layout WorkBuddy expects, with no key in them", () => {
  const packed = spawnSync(process.execPath, [join(ROOT, "scripts", "pack-workbuddy.mjs")], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const out = join(ROOT, "out", "workbuddy");
  const pub = JSON.parse(readFileSync(join(out, "surviagi", "mcp.json"), "utf8")).mcpServers.surviagi;
  assert.deepEqual([pub.type, pub.url, pub.headers], ["streamableHttp", "https://surviagi.com/api/mcp", undefined]);
  const sub = JSON.parse(readFileSync(join(out, "surviagi-submit", "mcp.json"), "utf8")).mcpServers["surviagi-submit"];
  assert.equal(sub.url, "https://surviagi.com/api/mcp/submit");
  assert.equal(sub.headers.Authorization, "Bearer ${SURVIAGI_API_KEY}");
  const schema = JSON.parse(readFileSync(join(out, "surviagi-submit", "token-schema.json"), "utf8"));
  assert.equal(schema.fields[0].key, "SURVIAGI_API_KEY");
  assert.equal(JSON.parse(readFileSync(join(out, "surviagi-submit", "connector-meta.json"), "utf8")).auth_mode, "token");
  for (const [connector, skill] of [["surviagi", "surviagi-search"], ["surviagi-submit", "surviagi-submit"]]) {
    for (const file of ["connector-meta.json", "icon.svg", `skills/${skill}/SKILL.md`]) assert.ok(existsSync(join(out, connector, file)), `${connector}/${file}`);
    const skillText = readFileSync(join(out, connector, "skills", skill, "SKILL.md"), "utf8");
    assert.match(skillText, /^---\nname: /);
    for (const field of ["display_name", "display_name_en", "description_zh", "description_en", "version", "author"]) assert.match(skillText, new RegExp(`\\n${field}: `), `${skill} ${field}`);
  }
});


test("public Skill downloads are complete, extractable, reproducible and limited to public sources", async () => {
  const expected = {
    "surviagi-http": ["surviagi-http/SKILL.md", "surviagi-http/scripts/surviagi.py"],
    surviagi: ["connector-meta.json", "mcp.json", "icon.svg", "skills/surviagi-search/SKILL.md"],
    "surviagi-submit": ["connector-meta.json", "mcp.json", "icon.svg", "skills/surviagi-submit/SKILL.md", "token-schema.json"],
  };
  for (const [name, paths] of Object.entries(expected)) {
    const path = `/api/agent/packages/${name}.zip`;
    const response = await fetch(`${site.base}${path}`, { headers: { cookie: "openaiwill_language=zh-CN" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="${name}.zip"`);
    const archive = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(archive, Buffer.from(await (await fetch(`${site.base}${path}`)).arrayBuffer()));
    // Validate with an independent ZIP reader, including CRCs and the Python script's syntax.
    const inspected = spawnSync("python3", ["-c", `
import io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    assert z.testzip() is None
    files = {name: z.read(name).decode() for name in z.namelist()}
    for name, content in files.items():
        if name.endswith('.py'): compile(content, name, 'exec')
    print(json.dumps(files))
`], { input: archive });
    assert.equal(inspected.status, 0, inspected.stderr.toString());
    const files = JSON.parse(inspected.stdout.toString());
    assert.deepEqual(Object.keys(files).sort(), paths.sort());
    if (name === "surviagi-http") {
      for (const path of paths) assert.equal(files[path], readFileSync(join(ROOT, "integrations/workbuddy/skill-http", path), "utf8"));
    } else {
      const connector = JSON.parse(files["mcp.json"]).mcpServers[name];
      assert.equal(connector.url, `https://surviagi.com/api/mcp${name === "surviagi-submit" ? "/submit" : ""}`);
      assert.equal(connector.headers?.Authorization, name === "surviagi-submit" ? "Bearer ${SURVIAGI_API_KEY}" : undefined);
    }
  }
  assert.equal((await fetch(`${site.base}/api/agent/packages/private.zip`)).status, 404);
  assert.equal((await fetch(`${site.base}/api/agent/packages/.env`)).status, 404);
  for (const language of ["en", "zh-CN"]) {
    const page = html(language, "/agents");
    assert.ok(page.includes('id="install"'));
    for (const name of Object.keys(expected)) assert.ok(page.includes(`/api/agent/packages/${name}.zip`));
    assert.ok(page.includes("Python 3"));
    assert.ok(page.includes("SKILL.md"));
    assert.match(html(language, ""), /<nav[^>]*>[\s\S]*?href="(?:\/zh-CN)?\/agents"[\s\S]*?<\/nav>/);
  }
});

test("the public data contract is served and the agent responses carry its four versions", async () => {
  const get = async (path) => {
    const res = await fetch(`${site.base}${path}`);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type") ?? "", /json/, path);
    return res.json();
  };
  const index = await get("/contract/v1/index.json");
  assert.match(index.contract_version, /^\d+\.\d+\.\d+$/);
  for (const entity of index.entities) assert.equal((await get(entity.schema)).title.length > 0, true, entity.name);
  const api = await get(index.openapi);
  assert.equal(api.info.version, index.contract_version);
  const llms = body("llms.txt");
  assert.ok(llms.includes("/contract/v1/index.json") && llms.includes("/contract/v1/openapi.json"));
  for (const language of ["en", "zh-CN"]) assert.ok(html(language, "/agents").includes("/contract/v1/openapi.json"));
  if (!HAS_SNAPSHOT) return;

  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema({ $id: "api", components: api.components });
  const search = await get("/api/agent/search?query=model&types=update,question,evidence&limit=3");
  const check = ajv.compile({ $ref: "api#/components/schemas/SearchResponse" });
  assert.ok(check(search), JSON.stringify(check.errors));
  assert.equal(search.versions.contract, index.contract_version);
  assert.equal(search.versions.ontology, JSON.parse(readFileSync(join(SNAPSHOT_DIR, "manifest.json"), "utf8")).schema_version);
  assert.ok(search.results.length > 0, "the sample search finds something");
  const found = await get(`/api/agent/record?id=${encodeURIComponent(search.results[0].id)}`);
  const checkRecord = ajv.compile({ $ref: "api#/components/schemas/RecordResponse" });
  assert.ok(checkRecord(found), JSON.stringify(checkRecord.errors));
  assert.deepEqual(found.versions, search.versions);
  const summary = await get("/api/agent/summary?market=accounting-audit-assurance");
  const checkSummary = ajv.compile({ $ref: "api#/components/schemas/SummaryResponse" });
  assert.ok(checkSummary(summary), JSON.stringify(checkSummary.errors));
  const list = await get("/api/agent/observations?limit=2");
  const checkList = ajv.compile({ $ref: "api#/components/schemas/ObservationsResponse" });
  assert.ok(checkList(list), JSON.stringify(checkList.errors));
  const changes = await get("/api/agent/changes?since=2026-01-01");
  const checkChanges = ajv.compile({ $ref: "api#/components/schemas/ChangesResponse" });
  assert.ok(checkChanges(changes), JSON.stringify(checkChanges.errors));
  // A release without observations says the counts are unknown, not zero.
  if (!existsSync(join(SNAPSHOT_DIR, "observations.json"))) {
    assert.deepEqual([summary.state, summary.counts, list.published, list.total, list.counts, changes.observations], ["unpublished", null, false, null, null, null]);
  }
});

// Issue #30: the evaluation set runs over the loaded release; its hit rate is reported, and a floor keeps a regression from passing.
test("search: the evaluation set finds a record about what each question asks in the first results", { skip: !HAS_SNAPSHOT, timeout: 60000 }, async () => {
  const { evaluate } = await import("../search-eval.mjs");
  // An address of its own, so the other tests' requests do not count against the per-address read limit.
  const report = await evaluate({ base: site.base, snapshotDir: SNAPSHOT_DIR, headers: { "cf-connecting-ip": "198.51.100.30" } });
  const pct = (v) => `${Math.round(v * 100)}%`;
  console.log(`# search eval hit@${report.k}: ${pct(report.hit_rate)} (en ${pct(report.by_language.en)}, zh-CN ${pct(report.by_language["zh-CN"])}), MRR ${report.mrr.toFixed(2)}; missed: ${report.rows.filter((r) => !r.hit).map((r) => r.id).join(", ") || "none"}`);
  assert.ok(report.questions >= 20);
  // Measured 2026-11-03 on the releases of 11-02: 88% (75% before observations, names in both languages and weighted terms).
  assert.ok(report.hit_rate >= 0.7, `hit rate ${pct(report.hit_rate)} fell below 70%`);
  assert.ok(report.by_language["zh-CN"] >= 0.6, `Chinese hit rate ${pct(report.by_language["zh-CN"])} fell below 60%`);
  // A Chinese question that has its own Chinese text answers in Chinese.
  const zh = report.rows.filter((r) => r.language === "zh-CN" && r.types.includes("question"));
  assert.ok(zh.length && zh.every((r) => r.titles_in_language > 0), "a Chinese query returns Chinese titles where a record has them");
});

// Issue #32: observations counted by evidence type on market and occupation pages, the same on the page and its copy.
test("market and occupation pages count their observations by evidence type and list them with their sources", { skip: !HAS_SNAPSHOT, timeout: 60000 }, async () => {
  const read = (name) => JSON.parse(readFileSync(join(SNAPSHOT_DIR, `${name}.json`), "utf8"));
  // A release without the collection says so instead of counting zero.
  if (!existsSync(join(SNAPSHOT_DIR, "observations.json"))) {
    const market = await (await fetch(`${site.base}/markets/accounting-audit-assurance`)).text();
    assert.ok(market.includes("This data release does not carry observations yet."));
    for (const path of ["/markets", "/occupations"]) {
      assert.ok((await (await fetch(`${site.base}${path}`)).text()).includes("This data release does not carry observations yet."), `${path} says the release has none`);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "surviagi-observations-"));
  cpSync(SNAPSHOT_DIR, dir, { recursive: true });
  const work = existsSync(join(SNAPSHOT_DIR, "work.json"))
    ? read("work").map((w) => ({ id: w.id, market_id: w.market_id }))
    : read("chain").activities.map((a) => ({ id: a.activity_id, market_id: a.market_id }));
  const marketId = work.find((w) => work.filter((x) => x.market_id === w.market_id).length >= 2).market_id;
  const [first, second] = work.filter((w) => w.market_id === marketId);
  const elsewhere = work.find((w) => w.market_id !== marketId);
  const occupation = read("occupations").find((o) => (o.tasks ?? 0) > 0);
  const day = (offset) => {
    const at = new Date(Date.parse(read("manifest").generated_at.slice(0, 10)) - offset * 86400000);
    return `${at.toISOString().slice(0, 10)}T08:00:00+00:00`;
  };
  const row = (id, fields) => ({
    observation_id: id, actor_key: `x:${id}`, actor_org_id: null, actor_person_id: null, actor_name: `Actor ${id}`,
    actor_role: "adopter", subject_key: "unspecified", subject_product_id: null, subject_model_id: null,
    work_key: fields.concerns[0].concept_id, event_id: null, task: `Task of ${id}`, outcome: "succeeded",
    direction: "ai_takes_on", scale: null, conditions: null, occurred_on: null, announced_at: null,
    observed_at: day(0), review_state: "machine_proposed", reviewed_at: null, extractor: "test", prompt_sha256: null,
    model: null, schema_version: "2.5.0", created_at: day(1), facts: [], merged_from: [],
    sources: [{ source_ref: `src-${id}`, source_type: "x_post", url: `https://x.com/a/status/${id.length}`, source_id: null, quote: `QUOTE ${id}`, published_at: null }],
    ...fields,
  });
  const concern = (concept_id, kind) => ({ concept_id, kind, label_en: null, label_zh_cn: null, method: "ai_proposed", status: "candidate" });
  writeFileSync(join(dir, "observations.json"), JSON.stringify([
    row("obs-a", {
      evidence_type: "production_use", announced_at: day(5),
      concerns: [concern(first.id, "work"), concern(second.id, "work"), { ...concern(occupation.id, "occupation"), label_en: occupation.label_en, label_zh_cn: occupation.label_zh_cn }],
      facts: [{ fact_id: "fact-a", value: "48", unit: "%", what: "share of tickets closed", baseline: null, method_note: null, quote: "FIGURE obs-a" }],
    }),
    row("obs-b", {
      evidence_type: "measurement", direction: "human_still_needed", outcome: "failed", announced_at: day(60), concerns: [concern(first.id, "work")],
      created_at: day(30), review_state: "human_confirmed", reviewed_at: day(2),
    }),
    row("obs-c", {
      evidence_type: "vendor_claim", concerns: [concern(second.id, "work")], created_at: day(30),
      sources: [
        { source_ref: "src-c1", source_type: "x_post", url: "https://x.com/a/status/31", source_id: null, quote: "QUOTE obs-c", published_at: day(31) },
        { source_ref: "src-c2", source_type: "x_post", url: "https://x.com/b/status/32", source_id: null, quote: "LATER obs-c", published_at: day(3) },
      ],
    }),
    row("obs-d", { evidence_type: "own_use", announced_at: day(1), concerns: [concern(elsewhere.id, "work")] }),
    row("obs-1111111111111111", { evidence_type: "vendor_claim", direction: "neutral", merged_from: ["obs-0000000000000001"], concerns: [concern(elsewhere.id, "work")] }),
  ]));
  const { base, proc } = await startServer({ SNAPSHOT_DIR: dir });
  try {
    const marketPath = `/markets/${marketId.replace(/^oaw:market:/, "")}`;
    const md = await (await fetch(`${base}${marketPath}/raw.md`)).text();
    assert.match(md, /3 observations bear on .*: 1 production use, 1 measurement, 1 vendor claim\./);
    for (const line of ["- Production use: 1", "- Measurement: 1", "- Statistic: 0", "- Own use: 0", "- Demonstration: 0", "- Vendor claim: 1",
      "1 of them says a person is still needed", "1 said in the 30 days before the data date, 2 in the 90 days.", "1 carries no date.",
      "### Evidence the other way", "QUOTE obs-a", "48 % — share of tickets closed", "FIGURE obs-a", "`obs-c`"]) {
      assert.ok(md.includes(line), `market copy lacks ${line}`);
    }
    assert.ok(!md.includes("obs-d"), "an observation on another market is counted here");
    // Strongest first: production use before the vendor claim; the one the other way in its own list.
    assert.ok(md.indexOf("`obs-a`") < md.indexOf("`obs-c`") && md.indexOf("`obs-c`") < md.indexOf("`obs-b`"));
    const page = await (await fetch(`${base}${marketPath}`)).text();
    for (const id of ["obs-a", "obs-b", "obs-c"]) assert.ok(page.includes(`id="${id}"`), `market page lacks ${id}`);
    assert.ok(page.includes("QUOTE obs-a") && !page.includes("obs-d"));
    const zh = await (await fetch(`${base}/zh-CN${marketPath}/raw.md`)).text();
    assert.ok(zh.includes("有 3 条观察涉及") && zh.includes("生产使用 1 条") && zh.includes("- 测量：1"), "Chinese copy");

    const occupationPath = `/occupations/${occupation.id.replace(/^oaw:occupation:/, "")}`;
    const occ = await (await fetch(`${base}${occupationPath}/raw.md`)).text();
    assert.match(occ, /1 observation bears on .*: 1 production use\./);
    assert.ok(occ.includes("None of them says a person is still needed.") && !occ.includes("obs-b"));
    assert.ok((await (await fetch(`${base}${occupationPath}`)).text()).includes('id="obs-a"'));

    // The list pages count the same rows once each, and each row links to its page's evidence.
    const marketCount = new Set(work.map((w) => w.market_id)).size;
    const markets = await (await fetch(`${base}/markets`)).text();
    assert.ok(markets.includes(`5 observations are mapped to 2 of the ${marketCount} markets: 1 production use, 1 measurement, 1 own use, 2 vendor claim.`), "markets overview");
    assert.ok(markets.includes(`href="${marketPath}#evidence">3</a>`), "the market row links its count to the page's evidence");
    // When they were said (every month back to the oldest, then the undated), who says them, and what was read.
    for (const month of [day(1), day(60)].map((d) => d.slice(0, 7))) assert.ok(markets.includes(`>${month}</span>`), `markets list month ${month}`);
    assert.match(markets, />no date<\/span>.*?<b>2<\/b>/s, "the two undated observations in their own row");
    assert.match(markets, /<dt>Adopter<\/dt><dd>5<small>/, "the actors' roles counted");
    assert.match(markets, /<dt>Practitioner<\/dt><dd>0<small>/, "a role nobody had shows 0");
    assert.ok(markets.includes("<span>Actor obs-a</span>") && markets.includes("1 observation</b>"), "the names that occur most");
    for (const line of ["40% of these observations rest on what the maker itself shows or says.", "0% come from individual practitioners; 5 name an organisation that adopted it.",
      "A market or occupation with no observation has not been read about"]) {
      assert.ok(markets.includes(line), `markets coverage lacks ${line}`);
    }
    assert.ok(/读自 \d+ 个关注账号/.test(await (await fetch(`${base}/zh-CN/markets`)).text()), "Chinese coverage names the accounts read");
    const occupationsPage = await (await fetch(`${base}/zh-CN/occupations`)).text();
    assert.match(occupationsPage, /有 1 条观察映射到 \d+ 个职业中的 1 个：生产使用 1 条。/, "occupations overview");

    const empty = work.find((w) => ![marketId, elsewhere.market_id].includes(w.market_id)).market_id;
    const none = await (await fetch(`${base}/markets/${empty.replace(/^oaw:market:/, "")}/raw.md`)).text();
    assert.ok(none.includes("No observation has been mapped here yet."));

    // Issue #29: the agent tools state the page's numbers, read from the same rows.
    const api = async (path) => {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, body: await res.json() };
    };
    const pageCounts = (copy) => Object.fromEntries([...copy.matchAll(/^- (Production use|Measurement|Statistic|Own use|Demonstration|Vendor claim): (\d+)$/gm)]
      .map(([, label, n]) => [label.toLowerCase().replace(" ", "_"), Number(n)]));
    const market = (await api(`/api/agent/summary?market=${marketId}`)).body;
    assert.equal(market.state, "some");
    assert.deepEqual(market.counts.by_evidence_type, pageCounts(md));
    assert.deepEqual([market.counts.total, market.counts.against, market.counts.last_30_days, market.counts.last_90_days, market.counts.undated], [3, 1, 1, 2, 1]);
    assert.deepEqual(market.strongest.map((o) => o.id), ["obs-a", "obs-c"]);
    assert.deepEqual(market.other_way.map((o) => o.id), ["obs-b"]);
    assert.equal(market.url, `https://surviagi.com${marketPath}`);
    const bySlug = (await api(`/api/agent/summary?market=${marketId.replace(/^oaw:market:/, "")}&language=zh-CN`)).body;
    assert.deepEqual(bySlug.counts, market.counts);
    assert.equal(bySlug.url, `https://surviagi.com/zh-CN${marketPath}`);
    const job = (await api(`/api/agent/summary?occupation=${encodeURIComponent(occupation.label_en)}`)).body;
    assert.equal(job.id, occupation.id);
    assert.deepEqual(job.counts.by_evidence_type, pageCounts(occ));
    assert.equal(job.counts.total, 1);
    assert.equal((await api("/api/agent/summary")).status, 400);
    assert.equal((await api(`/api/agent/summary?market=${marketId}&occupation=${occupation.id}`)).status, 400);
    const unknown = await api("/api/agent/summary?occupation=zzzz-no-such-job");
    assert.deepEqual([unknown.status, unknown.body.error, unknown.body.candidates], [404, "not_found", []]);

    const all = (await api(`/api/agent/observations?market=${marketId}`)).body;
    assert.deepEqual(all.counts, market.counts);
    assert.deepEqual(all.results.map((o) => o.id), ["obs-a", "obs-b", "obs-c"], "strength order: production use, measurement, vendor claim");
    const newest = (await api(`/api/agent/observations?market=${marketId}&order=newest`)).body;
    assert.deepEqual(newest.results.map((o) => o.id), ["obs-a", "obs-b", "obs-c"], "undated last");
    const against = (await api(`/api/agent/observations?directions=human_still_needed`)).body;
    assert.deepEqual([against.total, against.results[0].id, against.results[0].outcome], [1, "obs-b", "failed"]);
    const typed = (await api(`/api/agent/observations?evidence_types=production_use&evidence_types=own_use`)).body;
    assert.deepEqual(typed.results.map((o) => o.id).sort(), ["obs-a", "obs-d"]);
    const dated = (await api(`/api/agent/observations?from=${day(10).slice(0, 10)}`)).body;
    assert.deepEqual(dated.results.map((o) => o.id).sort(), ["obs-a", "obs-d"], "an undated observation passes no date filter");
    assert.equal((await api(`/api/agent/observations?organization=x:obs-d`)).body.total, 1);
    const first = (await api(`/api/agent/observations?limit=3`)).body;
    assert.deepEqual([first.total, first.results.length, typeof first.next_cursor], [5, 3, "string"]);
    const rest = (await api(`/api/agent/observations?limit=3&cursor=${first.next_cursor}`)).body;
    assert.deepEqual([rest.results.length, rest.next_cursor], [2, null]);
    assert.equal(new Set([...first.results, ...rest.results].map((o) => o.id)).size, 5);
    assert.equal((await api(`/api/agent/observations?cursor=nonsense`)).status, 400);
    assert.equal((await api(`/api/agent/observations?evidence_types=rumour`)).status, 400);
    const a = all.results[0];
    assert.deepEqual(a.facts, [{ value: "48", unit: "%", what: "share of tickets closed", quote: "FIGURE obs-a" }]);
    assert.equal(a.url, `https://surviagi.com${occupationPath}#obs-a`);

    const record = (await api("/api/agent/record?id=obs-1111111111111111")).body;
    assert.deepEqual([record.id, record.type, record.evidence_type, record.sources[0].quote, record.merged_into], ["obs-1111111111111111", "observation", "vendor_claim", "QUOTE obs-1111111111111111", undefined]);
    assert.deepEqual(record.pages.map((p) => [p.kind, p.id]), [["market", elsewhere.market_id]]);
    assert.equal((await api("/api/agent/record?id=obs-2222222222222222")).status, 404);
    const merged = (await api("/api/agent/record?id=obs-0000000000000001")).body;
    assert.deepEqual([merged.id, merged.merged_into, merged.requested_id], ["obs-1111111111111111", "obs-1111111111111111", "obs-0000000000000001"]);
    const viaMcp = await (await fetch(`${base}/api/mcp`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "occupation_summary", arguments: { market: marketId } } }),
    })).json();
    assert.deepEqual(viaMcp.result.structuredContent.counts, market.counts, "MCP and HTTP answer alike");

    // Issue #30: search finds observations by default, says why, and a Chinese query finds them through the names they carry.
    const found = (await api(`/api/agent/search?query=${encodeURIComponent("Task of obs-a")}`)).body;
    const hit = found.results.find((r) => r.id === "obs-a");
    assert.ok(hit, "an observation is searched by default");
    assert.deepEqual([hit.type, hit.title, hit.snippet, hit.content, hit.title_language], ["observation", "Task of obs-a", "FIGURE obs-a", "post_quote", "en"]);
    assert.deepEqual(hit.matched[0], { field: "task", terms: ["task", "obs-a"] });
    assert.equal(hit.url, `https://surviagi.com${occupationPath}#obs-a`);
    assert.equal(hit.markdown_url, `https://surviagi.com${occupationPath}/raw.md`, "the copy of the page, not of an anchor");
    assert.ok(!(await api(`/api/agent/search?query=${encodeURIComponent("Task of obs-a")}&types=update`)).body.results.some((r) => r.type === "observation"));
    if (occupation.label_zh_cn) {
      const zh = (await api(`/api/agent/search?query=${encodeURIComponent(occupation.label_zh_cn)}&types=observation&language=zh-CN`)).body;
      const byName = zh.results.find((r) => r.id === "obs-a");
      assert.ok(byName, `a Chinese query finds the observation through its occupation's name (${occupation.label_zh_cn})`);
      assert.equal(byName.matched[0].field, "concerns");
      assert.equal(byName.url, `https://surviagi.com/zh-CN${occupationPath}#obs-a`);
    }

    // Issue #29: what is new since a moment, read from the timestamps the loaded release carries.
    const since = day(10).slice(0, 10);
    const changes = (await api(`/api/agent/changes?since=${since}`)).body;
    assert.deepEqual([changes.since.basis, changes.since.at, changes.same_release], ["date", `${since}T00:00:00.000Z`, false]);
    const recorded = changes.observations.recorded;
    assert.deepEqual(recorded.results.map((o) => o.id), ["obs-a", "obs-d", "obs-1111111111111111"], "first recorded after the moment, strongest first among equals");
    assert.deepEqual([recorded.total, recorded.counts.total, recorded.counts.by_evidence_type.production_use, recorded.more], [3, 3, 1, null]);
    assert.deepEqual(recorded.pages[0], {
      kind: "market", id: elsewhere.market_id, label: recorded.pages[0].label, label_zh_cn: recorded.pages[0].label_zh_cn, new_observations: 2,
      url: `https://surviagi.com/markets/${elsewhere.market_id.replace(/^oaw:market:/, "")}`,
    });
    assert.deepEqual(changes.observations.new_sources.results.map((o) => [o.id, o.new_source_urls]), [["obs-c", ["https://x.com/b/status/32"]]], "an older observation a newer source also states");
    assert.deepEqual(changes.observations.reviewed.results.map((o) => [o.id, o.review_state]), [["obs-b", "human_confirmed"]]);
    assert.equal(changes.updates.basis, "happened_after");
    assert.ok(changes.updates.results.every((u) => u.date === null || u.date >= since));
    assert.equal(typeof changes.articles.available, "boolean");
    const paged = (await api(`/api/agent/changes?since=${since}&limit=1`)).body.observations.recorded;
    assert.deepEqual([paged.results.length, paged.more.tool, paged.more.arguments.order], [1, "query_observations", "recorded"]);
    const whole = (await api(`/api/agent/observations?${new URLSearchParams(paged.more.arguments)}`)).body;
    assert.deepEqual(whole.results.map((o) => o.id), recorded.results.map((o) => o.id), "more pages through the same rows");
    const scoped = (await api(`/api/agent/changes?since=${since}&market=${marketId}`)).body;
    assert.deepEqual([scoped.observations.recorded.total, scoped.observations.recorded.pages, scoped.updates, scoped.articles, scoped.scope.market.id], [1, null, null, null, marketId]);
    const loaded = (await api("/api/agent/search?query=model")).body.versions.data;
    const same = (await api(`/api/agent/changes?since=${loaded}`)).body;
    assert.deepEqual([same.since.basis, same.same_release, same.observations.recorded.total, same.observations.new_sources.total], ["release", true, 0, 0]);
    for (const bad of ["", "?since=yesterday", "?since=2999-01-01", `?since=${since}&limit=0`]) {
      assert.equal((await api(`/api/agent/changes${bad}`)).status, 400, bad);
    }
    const changesMcp = await (await fetch(`${base}/api/mcp`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "changes_since", arguments: { since, market: marketId } } }),
    })).json();
    assert.deepEqual(changesMcp.result.structuredContent.observations, scoped.observations, "MCP and HTTP answer alike");
  } finally {
    await stop(proc);
    rmSync(dir, { recursive: true, force: true });
  }
});
