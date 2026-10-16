import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, freePort, startServer, stop } from "./site-server.mjs";

// The signed-in paths, against the built server. A scratch database with a throwaway role holds the `app`
// schema; sessions are rows plus a cookie signed the way Better Auth signs it. The owner's working database
// and the real oaw_app role are never touched. Skipped when the local admin password file is absent.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PASSWORD_FILE = `${ROOT}data/postgres/password`;
// Locally a missing database is a visible skip with its reason. In CI `pnpm data:setup` has created it (see
// scripts/data-local.py and infra/docker-compose.yml: password file, 127.0.0.1:7543, user openaiwill), so
// there a missing file is not skipped: the setup fails loudly in `before`.
const SKIP = existsSync(PASSWORD_FILE) || process.env.CI ? false : "no local PostgreSQL (data/postgres/password; run pnpm data:setup)";
const SNAPSHOT_DIR = `${ROOT}datasets/published/latest`;
const HAS_SNAPSHOT = existsSync(`${SNAPSHOT_DIR}/manifest.json`);
const require = createRequire(import.meta.url);

const SECRET = randomBytes(24).toString("hex");
let base;
let names;
let admin;
let pool;
const people = {};

/** Better Auth 1.7.7 on an http base URL: cookie `better-auth.session_token`, value `<token>.<base64 HMAC-SHA256(token, secret)>`, URL-encoded. */
function cookieFor(token) {
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function makeUser(key, { name, verified = true }) {
  const id = `${key}-${randomBytes(3).toString("hex")}`;
  const email = `${id}@example.com`;
  await pool.query('INSERT INTO app."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, $4)', [id, name, email, verified]);
  const token = randomBytes(16).toString("hex");
  await pool.query(
    'INSERT INTO app.session (id, "expiresAt", token, "updatedAt", "userId") VALUES ($1, now() + interval \'1 day\', $2, now(), $3)',
    [`s-${id}`, token, id],
  );
  people[key] = { id, email, name, cookie: cookieFor(token) };
  return people[key];
}

before(async () => {
  if (SKIP) return;
  const { Client, Pool } = require("pg");
  const token = randomBytes(6).toString("hex");
  const password = randomBytes(16).toString("hex");
  names = { database: `openaiwill_signed_test_${token}`, role: `oaw_signed_test_${token}`, password };
  const adminPassword = readFileSync(PASSWORD_FILE, "utf8").trim();
  const connect = (database) => new Client({ host: "127.0.0.1", port: 7543, user: "openaiwill", password: adminPassword, database });
  admin = connect("postgres");
  await admin.connect();
  await admin.query(`CREATE DATABASE "${names.database}"`);
  const inner = connect(names.database);
  await inner.connect();
  try {
    await inner.query(`CREATE ROLE "${names.role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
    await inner.query(`ALTER ROLE "${names.role}" SET search_path = app`);
    await inner.query(`GRANT CONNECT ON DATABASE "${names.database}" TO "${names.role}"`);
    await inner.query(`CREATE SCHEMA app AUTHORIZATION "${names.role}"`);
  } finally {
    await inner.end();
  }
  pool = new Pool({ host: "127.0.0.1", port: 7543, user: names.role, password, database: names.database, max: 4 });
  await pool.query(readFileSync(`${ROOT}db/app/001_app.sql`, "utf8"));

  await makeUser("a", { name: "Ada Admin Zq" });
  await makeUser("b", { name: "Bob <script>x</script> & Co" });
  await makeUser("c", { name: "Cy Unverified", verified: false });
  await makeUser("d", { name: "Dee Tester Zq" });
  await makeUser("e", { name: "Eve Tester Zq" });
  await makeUser("f", { name: "=cmd" });
  await pool.query("INSERT INTO app.admins (email) VALUES ($1), ($2)", [people.a.email, people.c.email]);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startServer(
    {
      SNAPSHOT_DIR,
      APP_DATABASE_URL: `postgres://${names.role}:${password}@127.0.0.1:7543/${names.database}`,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: base,
      GOOGLE_CLIENT_ID: "dummy-id",
      GOOGLE_CLIENT_SECRET: "dummy-secret",
    },
    port,
  );
});

after(async () => {
  try {
    await cleanup();
    await pool?.end();
    if (admin && names) {
      await admin.query(`DROP DATABASE IF EXISTS "${names.database}" WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS "${names.role}"`);
    }
  } finally {
    await admin?.end();
  }
});

/** `who` is a key of `people`, or undefined for signed out. `origin`: true = the site's own, a string = that, false = none. */
function call(path, { who, method = "GET", origin = true, body, rawBody } = {}) {
  const headers = {};
  if (who) headers.cookie = people[who].cookie;
  if (origin) headers.origin = origin === true ? base : origin;
  if (body !== undefined || rawBody !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}${path}`, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
}
const submit = (who, fields, extra = {}) => call("/api/submissions", { who, method: "POST", body: fields, ...extra });
const decideAs = (who, fields, extra = {}) => call("/api/admin/submissions", { who, method: "POST", body: fields, ...extra });
const me = async (who) => (await call("/api/me", { who })).json();
/** `@name` as the page writes it: React puts a comment between the two text parts. */
const shows = (html, handle) => html.includes(`@${handle}`) || html.includes(`@<!-- -->${handle}`);
/** `t(name, fn)` or `t(name, { skip }, fn)`: a test's own skip reason is added to the file's. */
const t = (name, options, fn) => {
  if (typeof options === "function") [options, fn] = [{}, options];
  return test(name, { timeout: 60000, ...options, skip: SKIP || options.skip }, fn);
};

t("the signed cookie is accepted: get-session and /api/me return the user", async () => {
  const session = await (await call("/api/auth/get-session", { who: "a" })).json();
  assert.equal(session?.user?.email, people.a.email);
  const body = await me("a");
  assert.equal(body.enabled, true);
  assert.equal(body.user.email, people.a.email);
  assert.equal(body.user.name, "Ada Admin Zq");
  // A tampered signature is not a session.
  const forged = await fetch(`${base}/api/me`, { headers: { cookie: `${people.a.cookie.slice(0, -6)}AAAA` } });
  assert.equal((await forged.json()).user, null);
});

t("/api/me: administrator only for a verified listed address", async () => {
  assert.equal((await me("a")).admin, true);
  assert.equal((await me("b")).admin, false);
  const c = await me("c");
  assert.equal(c.user.email, people.c.email);
  assert.equal(c.admin, false);
  const out = await me(undefined);
  assert.equal(out.user, null);
  assert.equal(out.admin, false);
  assert.deepEqual((await me("b")).subscriptions, { updates: false, weekly: false });
});

t("the admin page and endpoints are a 404 for a reader, an unverified listed address and nobody", async () => {
  for (const who of ["b", "c", undefined]) {
    for (const path of ["/admin", "/zh-CN/admin", "/admin?view=decided"]) {
      assert.equal((await call(path, { who })).status, 404, `${who} ${path}`);
    }
    assert.equal((await decideAs(who, { handle: "x", ownerKind: "person", decision: "approve" })).status, 404, `${who} decide`);
    assert.equal((await call("/api/admin/subscribers", { who })).status, 404, `${who} csv`);
  }
  for (const path of ["/admin", "/zh-CN/admin"]) {
    // The streamed payload's chunk order varies from request to request, even for one visitor, so the
    // inline `self.__next_f.push(...)` scripts are removed before comparing; the rest is the document.
    const strip = (page) => page.replace(/<script>\(?self\.__next_f[\s\S]*?<\/script>/g, "");
    const raw = await (await call(path)).text();
    const out = strip(raw);
    // The not-found content reaches the browser in the streamed payload, not as markup.
    assert.ok(raw.includes(path.startsWith("/zh-CN") ? "页面不存在" : "Page not found"), "the site's own 404 page");
    for (const who of ["b", "c"]) {
      const other = strip(await (await call(path, { who })).text());
      let i = 0;
      while (i < out.length && out[i] === other[i]) i += 1;
      assert.equal(other, out, `${who} ${path} differs at ${i}: ${JSON.stringify(out.slice(i - 40, i + 80))} vs ${JSON.stringify(other.slice(i - 40, i + 80))}`);
    }
  }
});

t("submitting as a reader: origin, validation, duplicates, listing", async () => {
  const note = "<script>alert(1)</script> & more";
  assert.equal((await submit("b", { handle: "Shared1", ownerKind: "person" }, { origin: false })).status, 403);
  assert.equal((await submit("b", { handle: "Shared1", ownerKind: "person" }, { origin: "https://evil.example" })).status, 403);
  const created = await submit("b", { handle: "Shared1", ownerKind: "person", note });
  assert.equal(created.status, 200);
  const made = await created.json();
  assert.equal(made.result, "created");
  assert.equal(made.submission.handle, "Shared1");
  assert.equal(made.submission.note, note);
  for (const again of ["@shared1", "https://x.com/SHARED1/", "SHARED1"]) {
    const answer = await (await submit("b", { handle: again, ownerKind: "person" })).json();
    assert.equal(answer.result, "duplicate", again);
    assert.equal(answer.submission.handle, "Shared1");
  }
  const bad = async (fields) => (await submit("b", fields)).status;
  assert.equal(await bad({ handle: "not a handle!", ownerKind: "person" }), 400);
  assert.equal(await bad({ handle: "zqokname", ownerKind: "company" }), 400);
  assert.equal(await bad({ handle: "zqokname", ownerKind: "person", note: "😀".repeat(281) }), 400);
  assert.equal(await bad({ handle: "zqokname", ownerKind: "person", note: "a\u0000b" }), 400);
  assert.equal(await bad({ handle: "zqokname", ownerKind: "person", note: "x".repeat(5000) }), 400);
  assert.equal((await submit("b", { handle: "zqokname", ownerKind: "person", note: "😀".repeat(280) })).status, 200);
  // The body cap alone: everything else in the request is valid.
  assert.equal((await submit("b", { handle: "zqpad", ownerKind: "person", note: "short", pad: "x".repeat(5000) })).status, 400);
  assert.equal((await pool.query("SELECT 1 FROM app.submissions WHERE handle = 'zqpad'")).rows.length, 0, "no row for an oversized body");
  const list = await (await call("/api/submissions", { who: "b" })).json();
  assert.deepEqual(list.submissions.map((s) => s.handle).sort(), ["Shared1", "zqokname"]);
  assert.equal((await call("/api/submissions", { who: "d" })).status, 200);
  assert.deepEqual((await (await call("/api/submissions", { who: "d" })).json()).submissions, []);
});

t("an account already in the loaded data is reported as monitored", { skip: SKIP || !HAS_SNAPSHOT }, async () => {
  const sources = JSON.parse(readFileSync(`${SNAPSHOT_DIR}/sources.json`, "utf8"));
  const known = sources.find((s) => (s.platform ?? "x") === "x");
  const answer = await (await submit("b", { handle: known.handle.toUpperCase(), ownerKind: "person" })).json();
  assert.equal(answer.result, "monitored");
});

t("the eleventh pending submission is refused", async () => {
  for (let i = 1; i <= 10; i += 1) {
    assert.equal((await (await submit("e", { handle: `zqlim${i}`, ownerKind: "organization" })).json()).result, "created", `zqlim${i}`);
  }
  assert.deepEqual(await (await submit("e", { handle: "zqlim11", ownerKind: "organization" })).json(), { result: "limit", limit: 10 });
});

t("the administrator page shows the pending groups, escaped, in both languages", async () => {
  assert.equal((await submit("d", { handle: "shared1", ownerKind: "person" })).status, 200);
  const page = await call("/admin", { who: "a" });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("cache-control") ?? "", /no-store|private/);
  const html = await page.text();
  for (const label of ["Pending", "Decided", "Subscribers", "Download CSV", "2 requests", "1 request"]) assert.ok(html.includes(label), label);
  assert.ok(html.includes('href="https://x.com/shared1"'));
  assert.ok(shows(html, "Shared1"), "display spelling of the earliest request");
  assert.ok(html.includes("Bob &lt;script&gt;x&lt;/script&gt; &amp; Co"), "name is escaped");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more"), "note is escaped");
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(html.includes('href="/api/admin/subscribers"'));
  assert.ok(html.includes(people.b.email));
  // the organization group of the limit test is separate from person groups
  assert.ok(shows(html, "zqlim1"));

  const zh = await call("/zh-CN/admin", { who: "a" });
  assert.equal(zh.status, 200);
  const zhHtml = await zh.text();
  for (const label of ["待审核", "已处理", "订阅", "下载名单", "2 人提交"]) assert.ok(zhHtml.includes(label), label);
  assert.match(zhHtml, /<html lang="zh-CN"/);

  const garbage = await (await call("/admin?view=garbage", { who: "a" })).text();
  assert.ok(shows(garbage, "Shared1"), "an unknown view is the pending view");
  const decided = await (await call("/admin?view=decided", { who: "a" })).text();
  assert.ok(!shows(decided, "Shared1"));
  assert.ok(decided.includes("Nothing to review"));
});

t("deciding as an administrator: origin, validation, counts, reasons, decider", async () => {
  const ok = { handle: "shared1", ownerKind: "person", decision: "approve" };
  assert.equal((await decideAs("a", ok, { origin: false })).status, 403);
  assert.equal((await decideAs("a", ok, { origin: "https://evil.example" })).status, 403);
  assert.equal((await decideAs("a", { ...ok, handle: "Bad Handle" })).status, 400);
  assert.equal((await decideAs("a", { ...ok, ownerKind: "company" })).status, 400);
  assert.equal((await decideAs("a", { ...ok, decision: "maybe" })).status, 400);
  const reject = { handle: "zqokname", ownerKind: "person", decision: "reject" };
  assert.equal((await decideAs("a", { ...reject, reason: "   " })).status, 400);
  assert.equal((await decideAs("a", reject)).status, 400);
  assert.equal((await decideAs("a", { ...reject, reason: "😀".repeat(281) })).status, 400);
  assert.equal((await decideAs("a", { ...reject, reason: "a\u0000b" })).status, 400);
  assert.equal((await decideAs("a", ok, { rawBody: JSON.stringify({ ...ok, reason: "x".repeat(3000) }) })).status, 400);
  // The body cap alone: a valid pending group, a valid decision, and padding.
  assert.equal((await submit("d", { handle: "zqpadgrp", ownerKind: "person" })).status, 200);
  assert.equal((await decideAs("a", { handle: "zqpadgrp", ownerKind: "person", decision: "approve", pad: "x".repeat(5000) })).status, 400);
  assert.equal((await pool.query("SELECT status FROM app.submissions WHERE handle = 'zqpadgrp'")).rows[0].status, "pending");
  assert.equal((await pool.query("SELECT 1 FROM app.submissions WHERE status <> 'pending'")).rows.length, 0, "nothing was decided by a refused request");

  assert.deepEqual(await (await decideAs("a", ok)).json(), { changed: 2 });
  assert.deepEqual(await (await decideAs("a", ok)).json(), { changed: 0 });
  assert.deepEqual(await (await decideAs("a", { ...reject, reason: "  not relevant  " })).json(), { changed: 1 });
  // approve with a reason: the reason is ignored
  assert.equal((await submit("d", { handle: "zqappr1", ownerKind: "person" })).status, 200);
  assert.deepEqual(await (await decideAs("a", { handle: "zqappr1", ownerKind: "person", decision: "approve", reason: "ignored" })).json(), { changed: 1 });

  const { rows } = await pool.query("SELECT handle, status, decision_reason, decided_by FROM app.submissions WHERE status <> 'pending' ORDER BY handle, user_id");
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.decided_by, people.a.id);
  assert.deepEqual(rows.find((r) => r.handle === "zqokname"), { handle: "zqokname", status: "rejected", decision_reason: "not relevant", decided_by: people.a.id });
  assert.equal(rows.find((r) => r.handle === "zqappr1").decision_reason, null);
  assert.deepEqual(rows.filter((r) => r.handle === "shared1").map((r) => r.status), ["approved", "approved"]);

  const mine = (await (await call("/api/submissions", { who: "b" })).json()).submissions;
  assert.equal(mine.find((s) => s.handle === "Shared1").status, "approved");
  const rejected = mine.find((s) => s.handle === "zqokname");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason, "not relevant");

  const decided = await (await call("/admin?view=decided", { who: "a" })).text();
  assert.ok(shows(decided, "Shared1") && decided.includes("Approved") && decided.includes("Rejected") && decided.includes("not relevant"));
  assert.ok(decided.includes(people.a.email), "the decider is named");
});

t("after rows exist, the admin page still gives a reader or nobody nothing, in the raw payload too", async () => {
  const handles = ["Shared1", "shared1", "zqokname", "zqappr1", "zqpadgrp", ...Array.from({ length: 11 }, (_, i) => `zqlim${i + 1}`)];
  const secrets = [
    ...handles,
    ...Object.values(people).flatMap((person) => [person.email, person.name]),
    "<script>alert(1)</script>", "alert(1)", "😀".repeat(20), "not relevant",
  ];
  for (const who of ["b", "c", undefined]) {
    for (const path of ["/admin", "/zh-CN/admin", "/admin?view=decided"]) {
      const res = await call(path, { who });
      assert.equal(res.status, 404, `${who} ${path}`);
      const raw = await res.text();
      for (const secret of secrets) assert.ok(!raw.includes(secret), `${who} ${path} leaks ${secret.slice(0, 12)}`);
    }
  }
  const before = (await pool.query("SELECT id, status FROM app.submissions ORDER BY id")).rows;
  assert.ok(before.some((row) => row.status === "pending"));
  for (const who of ["b", "c", undefined]) {
    assert.equal((await decideAs(who, { handle: "zqlim1", ownerKind: "organization", decision: "reject", reason: "no" })).status, 404, who);
  }
  assert.deepEqual((await pool.query("SELECT id, status FROM app.submissions ORDER BY id")).rows, before, "nothing changed");
});

t("a reader votes on a topic of the loaded data, changes the vote and withdraws it", { skip: SKIP || !HAS_SNAPSHOT || !existsSync(`${SNAPSHOT_DIR}/topics.json`) }, async () => {
  const topic = JSON.parse(readFileSync(`${SNAPSHOT_DIR}/topics.json`, "utf8"))[0];
  const [first, second] = topic.options.map((option) => option.option_id);
  const path = `/api/topics/votes?topic=${encodeURIComponent(topic.topic_id)}`;
  const put = (option, extra) => call("/api/topics/votes", { who: "b", method: "PUT", body: { topic: topic.topic_id, option }, ...extra });

  // Counts are public; casting a vote needs a signed-in reader from this site.
  const before = await (await call(path)).json();
  assert.match(before.quarter, /^\d{4}-Q[1-4]$/);
  assert.equal(before.mine, null);
  assert.equal((await call("/api/topics/votes", { method: "PUT", body: { topic: topic.topic_id, option: first } })).status, 401);
  assert.equal((await put(first, { origin: false })).status, 403);

  const cast = await (await put(first)).json();
  assert.equal(cast.mine, first);
  assert.equal(cast.counts[cast.quarter][first], 1);
  const changed = await (await put(second)).json();
  assert.deepEqual(changed.counts[changed.quarter], { [second]: 1 });
  assert.equal((await (await call(path, { who: "b" })).json()).mine, second);
  assert.equal((await (await call(path)).json()).mine, null);

  // Only a topic and an answer of the loaded release can be voted on.
  assert.equal((await put(`${topic.topic_id}#h`)).status, 400);
  assert.equal((await call("/api/topics/votes", { who: "b", method: "PUT", body: { topic: "topic:replacement:nothing:00000000", option: null } })).status, 404);

  const withdrawn = await (await put(null)).json();
  assert.equal(withdrawn.mine, null);
  assert.deepEqual(withdrawn.counts, {});
});

t("subscriptions as a reader", async () => {
  const put = (fields, extra) => call("/api/subscriptions", { who: "b", method: "PUT", body: fields, ...extra });
  assert.equal((await put({ updates: true, weekly: true, language: "en" }, { origin: false })).status, 403);
  assert.equal((await put({ updates: "true", weekly: false, language: "en" })).status, 400);
  assert.equal((await put({ updates: true, weekly: false, language: "fr" })).status, 400);
  assert.equal((await call("/api/subscriptions", { method: "PUT", body: { updates: true, weekly: false, language: "en" } })).status, 401);
  assert.equal((await put({ updates: true, weekly: true, language: "zh-CN" })).status, 200);
  assert.deepEqual((await me("b")).subscriptions, { updates: true, weekly: true });
  assert.equal((await put({ updates: false, weekly: true, language: "zh-CN" })).status, 200);
  assert.deepEqual((await me("b")).subscriptions, { updates: false, weekly: true });
});

t("the subscriber list as CSV", async () => {
  assert.equal((await call("/api/subscriptions", { who: "f", method: "PUT", body: { updates: true, weekly: false, language: "en" } })).status, 200);
  const utcDay = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const dayBefore = utcDay();
  const res = await call("/api/admin/subscribers", { who: "a" });
  const dayAfter = utcDay();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.ok(
    [dayBefore, dayAfter].some((day) => res.headers.get("content-disposition") === `attachment; filename="surviagi-subscribers-${day}.csv"`),
    res.headers.get("content-disposition"),
  );
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
  assert.ok(text.startsWith("﻿email,name,language,topics,subscribed_at\r\n"));
  assert.ok(!/[^\r]\n/.test(text.replace(/"[^"]*"/g, "")), "CRLF line ends");
  const lines = text.slice(1).split("\r\n").filter(Boolean);
  assert.equal(lines.length, 3);
  const f = lines.find((line) => line.startsWith(people.f.email));
  assert.ok(f.startsWith(`${people.f.email},'=cmd,en,updates,`), f);
  assert.ok(lines.some((line) => line.startsWith(`${people.b.email},`) && line.includes(",zh-CN,weekly,")));
});

t("signing out ends the session", async () => {
  assert.equal((await me("a")).user.email, people.a.email);
  const out = await call("/api/auth/sign-out", { who: "a", method: "POST", body: {} });
  assert.ok(out.status < 400, `sign-out answered ${out.status}`);
  assert.equal((await me("a")).user, null);
  assert.equal((await call("/admin", { who: "a" })).status, 404);
});

/** One sign-in start; `ip` is the Cloudflare client address header, or undefined for none. */
const startSignInAs = (ip, body = { provider: "google", callbackURL: "/" }) =>
  fetch(`${base}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, ...(ip ? { "cf-connecting-ip": ip } : {}) },
    body: JSON.stringify(body),
  });

t("the rate limit follows cf-connecting-ip: two addresses are limited independently, a spoofed X-Forwarded-For counts for nothing", async () => {
  // Better Auth allows 3 sign-in starts per 10 seconds per client address (rate-limiter/index.mjs).
  const first = [];
  for (let i = 0; i < 4; i += 1) first.push((await startSignInAs("203.0.113.10")).status);
  assert.deepEqual(first, [200, 200, 200, 429]);
  assert.equal((await startSignInAs("203.0.113.11")).status, 200, "another address has its own allowance");
  const spoofed = await fetch(`${base}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.77" },
    body: JSON.stringify({ provider: "google", callbackURL: "/" }),
  });
  assert.equal(spoofed.status, 429, "a client-chosen X-Forwarded-For does not reset the limit");
});

t("without cf-connecting-ip (local, SSH forward) sign-in still works: requests share one allowance", async () => {
  const answers = [];
  for (let i = 0; i < 4; i += 1) answers.push((await startSignInAs(undefined)).status);
  assert.deepEqual(answers.slice(0, 3), [200, 200, 200]);
  assert.equal(answers[3], 429);
});

t("a failed sign-in comes back to the page it started from, or to the home page, with the marker", async () => {
  const started = await startSignInAs("203.0.113.20", { provider: "google", callbackURL: "/voices", errorCallbackURL: "/voices?signin=failed" });
  assert.equal(started.status, 200);
  const { url } = await started.json();
  const state = new URL(url).searchParams.get("state");
  assert.ok(state);
  const cookie = started.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
  const cancelled = await fetch(`${base}/api/auth/callback/google?state=${encodeURIComponent(state)}&error=access_denied`, { headers: { cookie }, redirect: "manual" });
  assert.ok([302, 303, 307].includes(cancelled.status), `callback answered ${cancelled.status}`);
  const where = cancelled.headers.get("location");
  assert.ok(where.startsWith("/voices?signin=failed"), where);
  assert.ok(where.includes("error=access_denied"), where);
  // No state at all: Better Auth's configured error address, our own page.
  const lost = await fetch(`${base}/api/auth/callback/google?error=access_denied`, { redirect: "manual" });
  assert.ok(lost.headers.get("location").startsWith("/?signin=failed"), lost.headers.get("location"));
  // The error address is checked like any callback address: a foreign one is refused.
  assert.equal((await startSignInAs("203.0.113.21", { provider: "google", callbackURL: "/", errorCallbackURL: "https://evil.example/" })).status, 403);
});

t("/healthz reports the user database as answering", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).app, { enabled: true, ok: true });
});

// Better Auth's own account row (with the encrypted Google tokens) is written only by the OAuth callback after
// Google has exchanged a code; no request here can produce one without a real Google session, so the
// encryption setting is covered by reading the configuration, not by a stored row.
t("Better Auth is configured to encrypt stored Google tokens and to read the client address from cf-connecting-ip", () => {
  const source = readFileSync(`${ROOT}src/lib/auth.ts`, "utf8");
  assert.match(source, /account:\s*\{\s*encryptOAuthTokens:\s*true\s*\}/);
  assert.match(source, /ipAddressHeaders:\s*\["cf-connecting-ip"\]/);
  assert.match(source, /errorURL:\s*"\/\?signin=failed"/);
});

test("with an unreachable user database /healthz says so, stays 200, and the public pages still answer", { timeout: 60000 }, async () => {
  const dead = await freePort();
  const port = await freePort();
  const { base: other, proc } = await startServer(
    {
      SNAPSHOT_DIR,
      APP_DATABASE_URL: `postgres://nobody:nothing@127.0.0.1:${dead}/none`,
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      GOOGLE_CLIENT_ID: "dummy-id",
      GOOGLE_CLIENT_SECRET: "dummy-secret",
    },
    port,
  );
  try {
    const res = await fetch(`${other}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.app, { enabled: true, ok: false });
    assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"), "no error text in the answer");
    assert.equal((await fetch(`${other}/`)).status, 200);
    assert.equal((await fetch(`${other}/zh-CN/voices`)).status, 200);
  } finally {
    await stop(proc);
  }
});
