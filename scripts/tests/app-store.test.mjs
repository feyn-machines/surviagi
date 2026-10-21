import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Real PostgreSQL, in a scratch database with a throwaway role. The owner's working database and the
// real oaw_app role are never touched. Skipped when the local admin password file is absent.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PASSWORD_FILE = `${ROOT}data/postgres/password`;
// Locally a missing database is a visible skip with its reason. In CI `pnpm data:setup` has created it (see
// scripts/data-local.py and infra/docker-compose.yml: password file, 127.0.0.1:7543, user openaiwill), so
// there a missing file is not skipped: the setup fails loudly in `before`.
const SKIP = existsSync(PASSWORD_FILE) || process.env.CI ? false : "no local PostgreSQL (data/postgres/password; run pnpm data:setup)";
const require = createRequire(import.meta.url);

let store;
let pool;
let admin;
let names;

const transpile = (path) =>
  ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;

before(async () => {
  if (SKIP) return;
  const { Client, Pool } = require("pg");
  const token = randomBytes(6).toString("hex");
  const password = randomBytes(16).toString("hex");
  names = { database: `openaiwill_store_test_${token}`, role: `oaw_store_test_${token}`, password };
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
  pool = new Pool({ host: "127.0.0.1", port: 7543, user: names.role, password, database: names.database, max: 6 });
  await pool.query(readFileSync(`${ROOT}db/app/001_app.sql`, "utf8"));
  const js = transpile(`${ROOT}src/lib/app-store.ts`);
  store = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(js)}`);
});

after(async () => {
  if (SKIP) return;
  await pool?.end();
  if (admin && names) {
    await admin.query(`DROP DATABASE IF EXISTS "${names.database}" WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${names.role}"`);
  }
  await admin?.end();
});

let counter = 0;
async function user() {
  counter += 1;
  const id = `u${counter}-${randomBytes(3).toString("hex")}`;
  await pool.query(
    'INSERT INTO app."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
    [id, `User ${counter}`, `${id}@example.com`],
  );
  return id;
}
const input = (userId, handle, extra = {}) => ({ userId, handle, key: handle.toLowerCase(), ownerKind: "person", note: null, ...extra });

test("a new account is created and listed", { skip: SKIP }, async () => {
  const id = await user();
  const made = await store.createSubmission(pool, input(id, "OpenAI", { note: "why" }));
  assert.equal(made.result, "created");
  assert.equal(made.submission.handle, "OpenAI");
  assert.equal(made.submission.status, "pending");
  assert.equal(made.submission.note, "why");
  assert.equal(made.submission.reason, null);
  assert.equal(made.submission.decidedAt, null);
  assert.equal(typeof made.submission.id, "string");
});

test("the same account again is a duplicate and returns the first row", { skip: SKIP }, async () => {
  const id = await user();
  const first = await store.createSubmission(pool, input(id, "Anthropic", { ownerKind: "organization" }));
  const again = await store.createSubmission(pool, input(id, "Anthropic", { ownerKind: "person", note: "later" }));
  assert.equal(again.result, "duplicate");
  assert.deepEqual(again.submission, first.submission);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM app.submissions WHERE user_id = $1", [id]);
  assert.equal(rows[0].n, 1);
});

test("the caller passes a lower-case key; display case is kept, comparison is on the key", { skip: SKIP }, async () => {
  const id = await user();
  await store.createSubmission(pool, input(id, "SamA"));
  const { rows } = await pool.query("SELECT handle, display_handle FROM app.submissions WHERE user_id = $1", [id]);
  assert.deepEqual(rows[0], { handle: "sama", display_handle: "SamA" });
  const again = await store.createSubmission(pool, { ...input(id, "SAMA"), key: "sama" });
  assert.equal(again.result, "duplicate");
  assert.equal(again.submission.handle, "SamA");
});

test("ten pending is the limit; a decision frees a place", { skip: SKIP }, async () => {
  const id = await user();
  for (let n = 0; n < store.PENDING_LIMIT; n += 1) {
    assert.equal((await store.createSubmission(pool, input(id, `acct_${n}`))).result, "created");
  }
  assert.equal((await store.createSubmission(pool, input(id, "acct_extra"))).result, "limit");
  // An existing account is still reported as a duplicate at the limit.
  assert.equal((await store.createSubmission(pool, input(id, "acct_3"))).result, "duplicate");
  await pool.query(
    "UPDATE app.submissions SET status = 'approved', decided_at = now() WHERE user_id = $1 AND handle = 'acct_0'",
    [id],
  );
  assert.equal((await store.createSubmission(pool, input(id, "acct_extra"))).result, "created");
});

test("two concurrent submits of one account give one created and one duplicate", { skip: SKIP }, async () => {
  const id = await user();
  const results = await Promise.all([
    store.createSubmission(pool, input(id, "Race")),
    store.createSubmission(pool, input(id, "Race")),
    store.createSubmission(pool, input(id, "Race")),
  ]);
  assert.deepEqual(results.map((r) => r.result).sort(), ["created", "duplicate", "duplicate"]);
});

test("concurrent submits cannot pass the limit", { skip: SKIP }, async () => {
  const id = await user();
  const results = await Promise.all(Array.from({ length: 14 }, (_, n) => store.createSubmission(pool, input(id, `burst_${n}`))));
  assert.equal(results.filter((r) => r.result === "created").length, store.PENDING_LIMIT);
  assert.equal(results.filter((r) => r.result === "limit").length, 4);
});

test("listing returns only the user's rows, newest first, with ISO timestamps", { skip: SKIP }, async () => {
  const mine = await user();
  const other = await user();
  await store.createSubmission(pool, input(mine, "first_one"));
  await store.createSubmission(pool, input(other, "not_mine"));
  await store.createSubmission(pool, input(mine, "second_one", { ownerKind: "organization" }));
  await pool.query(
    "UPDATE app.submissions SET status = 'rejected', decision_reason = 'no', decided_at = now() WHERE user_id = $1 AND handle = 'first_one'",
    [mine],
  );
  const list = await store.listSubmissions(pool, mine);
  assert.deepEqual(list.map((s) => s.handle), ["second_one", "first_one"]);
  assert.equal(list[0].ownerKind, "organization");
  for (const row of list) assert.equal(new Date(row.createdAt).toISOString(), row.createdAt);
  assert.equal(list[1].status, "rejected");
  assert.equal(list[1].reason, "no");
  assert.equal(new Date(list[1].decidedAt).toISOString(), list[1].decidedAt);
  assert.deepEqual(await store.listSubmissions(pool, "nobody"), []);
});

test("a submit for a user that does not exist is no_user and writes nothing", { skip: SKIP }, async () => {
  const made = await store.createSubmission(pool, input("ghost-user", "Ghost"));
  assert.deepEqual(made, { result: "no_user" });
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM app.submissions WHERE handle = 'ghost'");
  assert.equal(rows[0].n, 0);
});

const sub = (userId, extra = {}) => ({ userId, language: "en", updates: false, weekly: false, ...extra });
const rows = async (userId) =>
  (await pool.query("SELECT topic, language, subscribed_at, unsubscribed_at FROM app.subscriptions WHERE user_id = $1 ORDER BY topic", [userId])).rows;

test("subscribing to both topics stores two active rows", { skip: SKIP }, async () => {
  const id = await user();
  assert.deepEqual(await store.getSubscriptions(pool, id), { updates: false, weekly: false });
  assert.deepEqual(await store.setSubscriptions(pool, sub(id, { updates: true, weekly: true })), { updates: true, weekly: true });
  const stored = await rows(id);
  assert.deepEqual(stored.map((r) => r.topic), ["updates", "weekly"]);
  for (const row of stored) assert.equal(row.unsubscribed_at, null);
  assert.deepEqual(store.TOPICS, ["updates", "weekly"]);
});

test("unsubscribing keeps the row and reports false; saving again keeps subscribed_at", { skip: SKIP }, async () => {
  const id = await user();
  await store.setSubscriptions(pool, sub(id, { updates: true, weekly: true }));
  const before = await rows(id);
  assert.deepEqual(await store.setSubscriptions(pool, sub(id, { updates: true, weekly: false })), { updates: true, weekly: false });
  const after = await rows(id);
  assert.equal(after.length, 2);
  assert.equal(after[1].topic, "weekly");
  assert.ok(after[1].unsubscribed_at instanceof Date);
  assert.equal(after[0].unsubscribed_at, null);
  assert.deepEqual(after[0].subscribed_at, before[0].subscribed_at);
  // Unsubscribing again does not move the first unsubscribe time.
  await store.setSubscriptions(pool, sub(id, { updates: true, weekly: false }));
  assert.deepEqual((await rows(id))[1].unsubscribed_at, after[1].unsubscribed_at);
});

test("unsubscribing a topic never subscribed creates no row", { skip: SKIP }, async () => {
  const id = await user();
  assert.deepEqual(await store.setSubscriptions(pool, sub(id)), { updates: false, weekly: false });
  assert.deepEqual(await rows(id), []);
  await store.setSubscriptions(pool, sub(id, { weekly: true }));
  assert.deepEqual((await rows(id)).map((r) => r.topic), ["weekly"]);
});

test("re-subscribing clears unsubscribed_at and renews subscribed_at; language follows the last save", { skip: SKIP }, async () => {
  const id = await user();
  await store.setSubscriptions(pool, sub(id, { updates: true }));
  const first = (await rows(id))[0];
  await store.setSubscriptions(pool, sub(id));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await store.setSubscriptions(pool, sub(id, { updates: true, language: "zh-CN" })), { updates: true, weekly: false });
  const again = (await rows(id))[0];
  assert.equal(again.unsubscribed_at, null);
  assert.ok(again.subscribed_at > first.subscribed_at);
  assert.equal(again.language, "zh-CN");
  // Changing language while active keeps the date.
  await store.setSubscriptions(pool, sub(id, { updates: true, language: "en" }));
  const last = (await rows(id))[0];
  assert.equal(last.language, "en");
  assert.deepEqual(last.subscribed_at, again.subscribed_at);
});

test("one user's subscriptions do not affect another's", { skip: SKIP }, async () => {
  const a = await user();
  const b = await user();
  await store.setSubscriptions(pool, sub(a, { updates: true }));
  assert.deepEqual(await store.getSubscriptions(pool, b), { updates: false, weekly: false });
});

// Administrator view: groups, decisions, subscriber counts.
async function named(handle, kinds) {
  const id = await user();
  for (const kind of kinds) await store.createSubmission(pool, input(id, handle, { ownerKind: kind, note: `note ${kind}` }));
  return id;
}

test("pending groups merge the requests of one account and kind; kinds stay apart", { skip: SKIP }, async () => {
  const handle = `Grp${randomBytes(3).toString("hex")}`;
  await named(handle, ["person"]);
  await named(handle, ["organization"]);
  await named(handle, ["person"]);
  await named(handle, ["person"]);
  const groups = (await store.adminGroups(pool, "pending")).filter((g) => g.handle === handle.toLowerCase());
  assert.equal(groups.length, 2);
  const person = groups.find((g) => g.ownerKind === "person");
  assert.equal(person.count, 3);
  assert.equal(person.requests.length, 3);
  assert.equal(person.displayHandle, handle);
  assert.equal(person.status, "pending");
  assert.equal(groups.find((g) => g.ownerKind === "organization").count, 1);
});

test("deciding changes every pending row of the group once, leaves the other kind, and a second decision changes nothing", { skip: SKIP }, async () => {
  const handle = `Dec${randomBytes(3).toString("hex")}`;
  await named(handle, ["person"]);
  await named(handle, ["organization"]);
  await named(handle, ["person"]);
  await named(handle, ["person"]);
  const adminId = await user();
  const base = { handle: handle.toLowerCase(), ownerKind: "person", adminId };
  assert.equal(await store.decide(pool, { ...base, decision: "approved", reason: null }), 3);
  assert.equal(await store.decide(pool, { ...base, decision: "rejected", reason: "late" }), 0);
  const pending = (await store.adminGroups(pool, "pending")).filter((g) => g.handle === handle.toLowerCase());
  assert.deepEqual(pending.map((g) => g.ownerKind), ["organization"]);
  const decided = (await store.adminGroups(pool, "decided")).filter((g) => g.handle === handle.toLowerCase());
  assert.equal(decided.length, 1);
  assert.equal(decided[0].status, "approved");
  assert.equal(decided[0].count, 3);
  assert.equal(decided[0].decidedBy, `${adminId}@example.com`);
  assert.equal(decided[0].importedAt, null);
  assert.ok(decided[0].decidedAt);
});

test("a rejection stores its reason on every row", { skip: SKIP }, async () => {
  const handle = `Rej${randomBytes(3).toString("hex")}`;
  await named(handle, ["person"]);
  await named(handle, ["person"]);
  const adminId = await user();
  assert.equal(await store.decide(pool, { handle: handle.toLowerCase(), ownerKind: "person", decision: "rejected", reason: "spam", adminId }), 2);
  const { rows } = await pool.query("SELECT status, decision_reason, decided_by FROM app.submissions WHERE handle = $1", [handle.toLowerCase()]);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, "rejected");
    assert.equal(row.decision_reason, "spam");
    assert.equal(row.decided_by, adminId);
  }
  const group = (await store.adminGroups(pool, "decided")).find((g) => g.handle === handle.toLowerCase());
  assert.equal(group.reason, "spam");
});

test("subscriber counts count a user once and skip the unsubscribed", { skip: SKIP }, async () => {
  const before = await store.subscriberCounts(pool);
  const both = await user();
  const one = await user();
  const gone = await user();
  await store.setSubscriptions(pool, sub(both, { updates: true, weekly: true }));
  await store.setSubscriptions(pool, sub(one, { weekly: true, language: "zh-CN" }));
  await store.setSubscriptions(pool, sub(gone, { updates: true, weekly: true }));
  await store.setSubscriptions(pool, sub(gone));
  const after = await store.subscriberCounts(pool);
  assert.equal(after.total - before.total, 2);
  assert.equal(after.updates - before.updates, 1);
  assert.equal(after.weekly - before.weekly, 2);
  const rows = await store.subscriberRows(pool);
  const mine = rows.filter((r) => [both, one, gone].some((id) => r.email === `${id}@example.com`));
  assert.equal(mine.length, 2);
  assert.equal(mine.find((r) => r.email === `${both}@example.com`).topics, "updates+weekly");
  const second = mine.find((r) => r.email === `${one}@example.com`);
  assert.equal(second.topics, "weekly");
  assert.equal(second.language, "zh-CN");
  assert.match(second.subscribedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("saving subscriptions for a user that does not exist is a handled null, and writes nothing", { skip: SKIP }, async () => {
  assert.equal(await store.setSubscriptions(pool, sub("no-such-user", { updates: true })), null);
  const { rows } = await pool.query("SELECT 1 FROM app.subscriptions WHERE user_id = 'no-such-user'");
  assert.equal(rows.length, 0);
});

test("a group shows the display spelling of its earliest request", { skip: SKIP }, async () => {
  const token = randomBytes(3).toString("hex");
  const first = await user();
  const second = await user();
  await store.createSubmission(pool, input(first, `Case${token}`));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await store.createSubmission(pool, input(second, `CASE${token}`));
  const group = (await store.adminGroups(pool, "pending")).find((g) => g.handle === `case${token}`);
  assert.equal(group.count, 2);
  assert.equal(group.displayHandle, `Case${token}`);
});

test("a pending group says whether the account was decided before, and how it ended up", { skip: SKIP }, async () => {
  const token = randomBytes(3).toString("hex");
  const handle = `earlier${token}`;
  const [a, b, c, d] = [await user(), await user(), await user(), await user()];
  const adminId = await user();
  const pendingGroup = async (ownerKind = "person") =>
    (await store.adminGroups(pool, "pending")).find((g) => g.handle === handle && g.ownerKind === ownerKind);
  await store.createSubmission(pool, input(a, handle));
  assert.equal((await pendingGroup()).earlier, null);
  assert.equal(await store.decide(pool, { handle, ownerKind: "person", decision: "approved", reason: null, adminId }), 1);
  await store.createSubmission(pool, input(b, handle));
  assert.equal((await pendingGroup()).earlier, "approved");
  assert.equal(await store.decide(pool, { handle, ownerKind: "person", decision: "rejected", reason: "no", adminId }), 1);
  await store.createSubmission(pool, input(c, handle));
  assert.equal((await pendingGroup()).earlier, "rejected", "the most recent decision");
  // Another kind of the same handle has no history of its own.
  await store.createSubmission(pool, input(d, handle, { ownerKind: "organization" }));
  assert.equal((await pendingGroup("organization")).earlier, null);
  for (const group of await store.adminGroups(pool, "decided")) assert.equal(group.earlier, null);
});

test("deleting a user by e-mail (the privacy page's promise) removes everything of theirs and keeps what they decided", { skip: SKIP }, async () => {
  const reader = await user();
  const reviewer = await user();
  const other = await user();
  const handle = `gone${randomBytes(3).toString("hex")}`;
  await store.createSubmission(pool, input(reader, handle));
  await store.createSubmission(pool, input(other, handle));
  await pool.query("INSERT INTO app.subscriptions (user_id, topic, language) VALUES ($1, 'weekly', 'en')", [reader]);
  await pool.query('INSERT INTO app.session (id, "expiresAt", token, "updatedAt", "userId") VALUES ($1, now() + interval \'1 day\', $2, now(), $3)', [`s-${reader}`, `t-${reader}`, reader]);
  await pool.query('INSERT INTO app."account" ("id", "accountId", "providerId", "userId", "updatedAt") VALUES ($1, $1, \'google\', $2, now())', [`a-${reader}`, reader]);
  await store.decide(pool, { handle, ownerKind: "person", decision: "approved", reason: null, adminId: reviewer });
  const email = `${reviewer}@example.com`.toUpperCase();
  const gone = await pool.query('DELETE FROM app."user" WHERE lower(email) = lower($1) RETURNING id', [email]);
  assert.deepEqual(gone.rows.map((row) => row.id), [reviewer]);
  const kept = await pool.query("SELECT user_id, status, decided_by FROM app.submissions WHERE handle = $1 ORDER BY user_id", [handle]);
  assert.equal(kept.rows.length, 2, "the decided rows of other people stay");
  for (const row of kept.rows) assert.equal(row.decided_by, null);
  const mine = (await pool.query('DELETE FROM app."user" WHERE id = $1 RETURNING id', [reader])).rows.length;
  assert.equal(mine, 1);
  for (const table of ["submissions", "subscriptions", "session", '"account"']) {
    const column = table === "session" || table === '"account"' ? '"userId"' : "user_id";
    assert.equal((await pool.query(`SELECT 1 FROM app.${table} WHERE ${column} = $1`, [reader])).rows.length, 0, table);
  }
});

// ---------------------------------------------------------------- topic votes ----

const TOPIC = "topic:replacement:accountant:b5615a30";
const option = (key) => `${TOPIC}#${key}`;

test("a quarter is a calendar quarter in UTC, and the database agrees", { skip: SKIP }, async () => {
  assert.equal(store.quarterOf(new Date("2026-09-30T23:59:59Z")), "2026-Q3");
  assert.equal(store.quarterOf(new Date("2026-10-01T00:00:00Z")), "2026-Q4");
  assert.equal(store.quarterOf(new Date("2027-01-01T00:00:00Z")), "2027-Q1");
  const { rows } = await pool.query("SELECT app.quarter_of(now()) AS q");
  assert.equal(rows[0].q, store.quarterOf(new Date()));
});

test("a reader has one vote per topic and quarter; voting again changes it", { skip: SKIP }, async () => {
  const [ann, bob] = [await user(), await user()];
  const quarter = store.quarterOf(new Date());
  assert.equal(await store.castVote(pool, { userId: ann, topicId: TOPIC, optionId: option("a"), quarter }), true);
  assert.equal(await store.castVote(pool, { userId: bob, topicId: TOPIC, optionId: option("a"), quarter }), true);
  assert.deepEqual(await store.voteCounts(pool, TOPIC), { [quarter]: { [option("a")]: 2 } });
  await store.castVote(pool, { userId: ann, topicId: TOPIC, optionId: option("b"), quarter });
  assert.deepEqual(await store.voteCounts(pool, TOPIC), { [quarter]: { [option("a")]: 1, [option("b")]: 1 } });
  assert.equal(await store.myVote(pool, ann, TOPIC, quarter), option("b"));
});

test("a vote can be withdrawn, and a reader who is gone casts none", { skip: SKIP }, async () => {
  const ann = await user();
  const quarter = store.quarterOf(new Date());
  const topic = "topic:viability:software-business:0a1b2c3d";
  await store.castVote(pool, { userId: ann, topicId: topic, optionId: `${topic}#a`, quarter });
  await store.castVote(pool, { userId: ann, topicId: topic, optionId: null, quarter });
  assert.equal(await store.myVote(pool, ann, topic, quarter), null);
  assert.deepEqual(await store.voteCounts(pool, topic), {});
  assert.equal(await store.castVote(pool, { userId: "nobody", topicId: topic, optionId: `${topic}#a`, quarter }), false);
});

test("an ended quarter is closed, and an answer of another topic is refused", { skip: SKIP }, async () => {
  const ann = await user();
  await assert.rejects(
    store.castVote(pool, { userId: ann, topicId: TOPIC, optionId: option("a"), quarter: "2020-Q1" }),
    /running quarter/,
  );
  await assert.rejects(
    store.castVote(pool, { userId: ann, topicId: TOPIC, optionId: "topic:replacement:lawyer:00000000#a", quarter: store.quarterOf(new Date()) }),
    /topic_votes_option_of_topic/,
  );
});

test("removing a reader removes their votes", { skip: SKIP }, async () => {
  const ann = await user();
  const quarter = store.quarterOf(new Date());
  const topic = "topic:replacement:truck-driver:11111111";
  await store.castVote(pool, { userId: ann, topicId: topic, optionId: `${topic}#a`, quarter });
  await pool.query('DELETE FROM app."user" WHERE id = $1', [ann]);
  assert.deepEqual(await store.voteCounts(pool, topic), {});
});
