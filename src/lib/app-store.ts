import type { Pool, PoolClient } from "pg";
import type { OwnerKind } from "./handles";

/**
 * Reader submissions in schema `app`. Every function takes the pool first so the tests can pass their
 * own. Imports are type-only: the tests transpile this file and load it as it is.
 */

export type Submission = {
  id: string;
  handle: string;
  ownerKind: OwnerKind;
  note: string | null;
  /** The field the account is suggested for; only agents send it so far. */
  field: string | null;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  via: Via;
  createdAt: string;
  decidedAt: string | null;
  importedAt: string | null;
};

/** Where a request was made: the site's own form, or an agent with the reader's API key. */
export type Via = "web" | "api";

/** A refusal for quota names which quota: the pending requests, or the new requests of the day (UTC). */
export type Limited = { result: "limit"; scope: "pending" | "daily"; limit: number };

export type CreateResult =
  | { result: "created"; submission: Submission }
  | { result: "duplicate"; submission: Submission }
  /** The same `requestId` again: the row the first attempt made, unchanged. */
  | { result: "replayed"; submission: Submission }
  | Limited
  | { result: "no_user" };

export const PENDING_LIMIT = 10;
/** New account requests one reader may make in one UTC day, from the site and from agents together. */
export const ACCOUNT_DAILY_LIMIT = 20;

type Row = {
  id: string;
  display_handle: string;
  owner_kind: OwnerKind;
  note: string | null;
  field: string | null;
  status: Submission["status"];
  decision_reason: string | null;
  via: Via;
  created_at: Date;
  decided_at: Date | null;
  imported_at: Date | null;
};

const COLUMNS = "id, display_handle, owner_kind, note, field, status, decision_reason, via, created_at, decided_at, imported_at";

const iso = (moment: Date | null) => (moment ? moment.toISOString() : null);

function toSubmission(row: Row): Submission {
  return {
    id: String(row.id),
    handle: row.display_handle,
    ownerKind: row.owner_kind,
    note: row.note,
    field: row.field,
    status: row.status,
    reason: row.decision_reason,
    via: row.via,
    createdAt: row.created_at.toISOString(),
    decidedAt: iso(row.decided_at),
    importedAt: iso(row.imported_at),
  };
}

/** The user's submissions, newest first. */
export async function listSubmissions(db: Pool, userId: string): Promise<Submission[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM app.submissions WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
    [userId],
  );
  return rows.map(toSubmission);
}

type Client = PoolClient;

/**
 * Pending rows and rows made since the UTC day began, of one reader in one table. Counted from the rows
 * themselves, inside the caller's transaction and under its lock on the user: nothing to keep in step, a
 * new key cannot reset it, and a request that made no row (refused, failed, duplicate, retried) used nothing.
 */
async function quota(client: Client, table: "submissions" | "questions", userId: string) {
  const { rows } = await client.query<{ pending: number; today: number }>(
    `SELECT (count(*) FILTER (WHERE status = 'pending'))::int AS pending,
            (count(*) FILTER (WHERE created_at >= date_trunc('day', now(), 'UTC')))::int AS today
       FROM app.${table} WHERE user_id = $1`,
    [userId],
  );
  return rows[0];
}

/**
 * One transaction per call. The lock on the user's row serialises that user's submits, so the replay and
 * duplicate checks and both quotas cannot be raced. `key` is the lower-case handle. Order: a replayed
 * request, then a duplicate account, then the pending quota, then the daily one.
 */
export async function createSubmission(
  db: Pool,
  input: {
    userId: string;
    handle: string;
    key: string;
    ownerKind: OwnerKind;
    note: string | null;
    field?: string | null;
    via?: Via;
    apiKeyId?: string | null;
    requestId?: string | null;
  },
): Promise<CreateResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query('SELECT 1 FROM app."user" WHERE id = $1 FOR UPDATE', [input.userId]);
    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return { result: "no_user" };
    }
    if (input.requestId) {
      const replay = await client.query<Row>(
        `SELECT ${COLUMNS} FROM app.submissions WHERE user_id = $1 AND request_id = $2`,
        [input.userId, input.requestId],
      );
      if (replay.rows[0]) {
        await client.query("COMMIT");
        return { result: "replayed", submission: toSubmission(replay.rows[0]) };
      }
    }
    const existing = await client.query<Row>(
      `SELECT ${COLUMNS} FROM app.submissions WHERE user_id = $1 AND platform = 'x' AND handle = $2`,
      [input.userId, input.key],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { result: "duplicate", submission: toSubmission(existing.rows[0]) };
    }
    const used = await quota(client, "submissions", input.userId);
    const refused: Limited | null =
      used.pending >= PENDING_LIMIT ? { result: "limit", scope: "pending", limit: PENDING_LIMIT }
      : used.today >= ACCOUNT_DAILY_LIMIT ? { result: "limit", scope: "daily", limit: ACCOUNT_DAILY_LIMIT }
      : null;
    if (refused) {
      await client.query("COMMIT");
      return refused;
    }
    const made = await client.query<Row>(
      `INSERT INTO app.submissions (user_id, handle, display_handle, owner_kind, note, field, via, api_key_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
      [input.userId, input.key, input.handle, input.ownerKind, input.note, input.field ?? null, input.via ?? "web",
        input.apiKeyId ?? null, input.requestId ?? null],
    );
    await client.query("COMMIT");
    return { result: "created", submission: toSubmission(made.rows[0]) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const TOPICS = ["updates", "weekly"] as const;
export type Topic = (typeof TOPICS)[number];
export type Subscriptions = { updates: boolean; weekly: boolean };

/** Which topics the user is subscribed to now. */
export async function getSubscriptions(db: Pool, userId: string): Promise<Subscriptions> {
  const { rows } = await db.query<{ topic: Topic }>(
    "SELECT topic FROM app.subscriptions WHERE user_id = $1 AND unsubscribed_at IS NULL",
    [userId],
  );
  const active = new Set(rows.map((row) => row.topic));
  return { updates: active.has("updates"), weekly: active.has("weekly") };
}

/**
 * Sets both topics at once. On: upsert, active again, language as given; `subscribed_at` is kept while
 * the topic stays active and renewed when it was unsubscribed. Off: marks the row unsubscribed only if
 * it is active; a topic never subscribed gets no row.
 */
export async function setSubscriptions(
  db: Pool,
  input: { userId: string; language: "en" | "zh-CN"; updates: boolean; weekly: boolean },
): Promise<Subscriptions | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query('SELECT 1 FROM app."user" WHERE id = $1 FOR UPDATE', [input.userId]);
    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    for (const topic of TOPICS) {
      if (input[topic]) {
        await client.query(
          `INSERT INTO app.subscriptions (user_id, topic, language) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, topic) DO UPDATE SET
             language = EXCLUDED.language,
             subscribed_at = CASE WHEN app.subscriptions.unsubscribed_at IS NULL THEN app.subscriptions.subscribed_at ELSE now() END,
             unsubscribed_at = NULL`,
          [input.userId, topic, input.language],
        );
      } else {
        await client.query(
          "UPDATE app.subscriptions SET unsubscribed_at = now() WHERE user_id = $1 AND topic = $2 AND unsubscribed_at IS NULL",
          [input.userId, topic],
        );
      }
    }
    const { rows } = await client.query<{ topic: Topic }>(
      "SELECT topic FROM app.subscriptions WHERE user_id = $1 AND unsubscribed_at IS NULL",
      [input.userId],
    );
    await client.query("COMMIT");
    const active = new Set(rows.map((row) => row.topic));
    return { updates: active.has("updates"), weekly: active.has("weekly") };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type AdminGroup = {
  handle: string;
  displayHandle: string;
  ownerKind: OwnerKind;
  status: "pending" | "approved" | "rejected";
  count: number;
  firstAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  reason: string | null;
  importedAt: string | null;
  /** Pending groups only: how rows for the same account and kind were last decided, null when never. */
  earlier: "approved" | "rejected" | null;
  requests: { name: string; email: string; note: string | null; createdAt: string }[];
};

type GroupRow = {
  handle: string;
  display_handle: string;
  owner_kind: OwnerKind;
  status: AdminGroup["status"];
  count: number;
  first_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  reason: string | null;
  imported_at: Date | null;
  earlier: "approved" | "rejected" | null;
  requests: { name: string; email: string; note: string | null; createdAt: string }[];
};

const MAX_DECIDED_GROUPS = 200;

/**
 * Pending: one group per account and kind, oldest first. Decided: one group per account, kind and
 * decision moment, newest first, at most 200. `decidedBy` is the deciding user's address.
 */
export async function adminGroups(db: Pool, view: "pending" | "decided"): Promise<AdminGroup[]> {
  const pending = view === "pending";
  const { rows } = await db.query<GroupRow>(
    `SELECT s.handle, (array_agg(s.display_handle ORDER BY s.created_at, s.id))[1] AS display_handle, s.owner_kind, s.status,
            count(*)::int AS count, min(s.created_at) AS first_at,
            s.decided_at, min(d.email) AS decided_by, min(s.decision_reason) AS reason, min(s.imported_at) AS imported_at,
            ${pending ? `(SELECT p.status FROM app.submissions p
                          WHERE p.platform = 'x' AND p.handle = s.handle AND p.owner_kind = s.owner_kind AND p.status <> 'pending'
                          ORDER BY p.decided_at DESC, p.id DESC LIMIT 1)` : "NULL"} AS earlier,
            json_agg(json_build_object('name', u.name, 'email', u.email, 'note', s.note, 'createdAt', s.created_at)
                     ORDER BY s.created_at, s.id) AS requests
       FROM app.submissions s
       JOIN app."user" u ON u.id = s.user_id
       LEFT JOIN app."user" d ON d.id = s.decided_by
      WHERE s.platform = 'x' AND ${pending ? "s.status = 'pending'" : "s.status <> 'pending'"}
      GROUP BY s.handle, s.owner_kind, s.status, s.decided_at
      ORDER BY ${pending ? "min(s.created_at), s.handle, s.owner_kind" : "s.decided_at DESC, s.handle, s.owner_kind, s.status"}
      ${pending ? "" : `LIMIT ${MAX_DECIDED_GROUPS}`}`,
  );
  return rows.map((row) => ({
    handle: row.handle,
    displayHandle: row.display_handle,
    ownerKind: row.owner_kind,
    status: row.status,
    count: row.count,
    firstAt: row.first_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    decidedBy: row.decided_by,
    reason: row.reason,
    importedAt: row.imported_at ? row.imported_at.toISOString() : null,
    earlier: row.earlier,
    requests: row.requests,
  }));
}

/**
 * Decides every pending row of the account and kind in one statement; returns how many rows changed.
 * 0 means someone decided it first. Decided rows are not touched (the trigger would refuse them).
 */
export async function decide(
  db: Pool,
  input: { handle: string; ownerKind: OwnerKind; decision: "approved" | "rejected"; reason: string | null; adminId: string },
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE app.submissions
        SET status = $1, decided_by = $2, decision_reason = $3, decided_at = now()
      WHERE platform = 'x' AND handle = $4 AND owner_kind = $5 AND status = 'pending'`,
    [input.decision, input.adminId, input.decision === "rejected" ? input.reason : null, input.handle, input.ownerKind],
  );
  return rowCount ?? 0;
}

/** Active subscriptions only; `total` counts each user once. */
export async function subscriberCounts(db: Pool): Promise<{ total: number; updates: number; weekly: number }> {
  const { rows } = await db.query<{ total: number; updates: number; weekly: number }>(
    `SELECT count(DISTINCT user_id)::int AS total,
            (count(*) FILTER (WHERE topic = 'updates'))::int AS updates,
            (count(*) FILTER (WHERE topic = 'weekly'))::int AS weekly
       FROM app.subscriptions WHERE unsubscribed_at IS NULL`,
  );
  return rows[0];
}

/** One row per user with an active subscription; topics joined with "+", the earliest active date. */
export async function subscriberRows(
  db: Pool,
): Promise<{ email: string; name: string; language: string; topics: string; subscribedAt: string }[]> {
  const { rows } = await db.query<{ email: string; name: string; language: string; topics: string; subscribed_at: Date }>(
    `SELECT u.email, u.name,
            (array_agg(s.language ORDER BY s.subscribed_at DESC, s.topic))[1] AS language,
            string_agg(s.topic, '+' ORDER BY s.topic) AS topics,
            min(s.subscribed_at) AS subscribed_at
       FROM app.subscriptions s JOIN app."user" u ON u.id = s.user_id
      WHERE s.unsubscribed_at IS NULL
      GROUP BY u.id, u.email, u.name
      ORDER BY min(s.subscribed_at), u.email`,
  );
  return rows.map((row) => ({ email: row.email, name: row.name, language: row.language, topics: row.topics, subscribedAt: row.subscribed_at.toISOString() }));
}

/** The calendar quarter (UTC) a moment falls in, written as the pipeline writes it: `2026-Q4`. */
export function quarterOf(moment: Date): string {
  return `${moment.getUTCFullYear()}-Q${Math.floor(moment.getUTCMonth() / 3) + 1}`;
}

/** Votes on one topic: `{ "2026-Q4": { "<option id>": 3 } }`. A quarter nobody voted in is absent. */
export type VoteCounts = Record<string, Record<string, number>>;

export async function voteCounts(db: Pool, topicId: string): Promise<VoteCounts> {
  const { rows } = await db.query<{ quarter: string; option_id: string; n: number }>(
    "SELECT quarter, option_id, count(*)::int AS n FROM app.topic_votes WHERE topic_id = $1 GROUP BY quarter, option_id",
    [topicId],
  );
  const counts: VoteCounts = {};
  for (const row of rows) (counts[row.quarter] ??= {})[row.option_id] = row.n;
  return counts;
}

/** The answer this reader chose for the topic in that quarter, or null. */
export async function myVote(db: Pool, userId: string, topicId: string, quarter: string): Promise<string | null> {
  const { rows } = await db.query<{ option_id: string }>(
    "SELECT option_id FROM app.topic_votes WHERE user_id = $1 AND topic_id = $2 AND quarter = $3",
    [userId, topicId, quarter],
  );
  return rows[0]?.option_id ?? null;
}

/**
 * Sets, changes or (with `optionId` null) withdraws the reader's vote in the running quarter. The caller
 * has checked that the topic and the answer are in the loaded data release. False when the user is gone.
 */
export async function castVote(
  db: Pool,
  input: { userId: string; topicId: string; optionId: string | null; quarter: string },
): Promise<boolean> {
  if (input.optionId === null) {
    await db.query("DELETE FROM app.topic_votes WHERE user_id = $1 AND topic_id = $2 AND quarter = $3", [
      input.userId, input.topicId, input.quarter,
    ]);
    return true;
  }
  const made = await db.query(
    `INSERT INTO app.topic_votes (user_id, topic_id, quarter, option_id)
     SELECT id, $2, $3, $4 FROM app."user" WHERE id = $1
     ON CONFLICT (user_id, topic_id, quarter) DO UPDATE SET option_id = EXCLUDED.option_id`,
    [input.userId, input.topicId, input.quarter, input.optionId],
  );
  return (made.rowCount ?? 0) > 0;
}

/* ---------- Research questions (Issue #5) ---------- */

export type QuestionStatus = "pending" | "accepted" | "rejected";

export type Question = {
  id: string;
  question: string;
  why: string;
  gap: string;
  leads: string | null;
  related: string[];
  language: "en" | "zh-CN";
  status: QuestionStatus;
  reason: string | null;
  via: Via;
  createdAt: string;
  decidedAt: string | null;
};

export type QuestionResult =
  | { result: "created"; question: Question }
  | { result: "duplicate"; question: Question }
  | { result: "replayed"; question: Question }
  | Limited
  | { result: "no_user" };

/** New questions one reader may submit in one UTC day, and how many may wait for review at once. */
export const QUESTION_DAILY_LIMIT = 5;
export const QUESTION_PENDING_LIMIT = 20;

/**
 * A question folded for comparison: compatibility forms unified, case dropped, everything but letters and
 * digits removed. "Will AI replace X?" and "will ai replace x" are the same question; a reworded one is not.
 */
export function questionKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 300);
}

type QuestionRow = {
  id: string;
  question: string;
  why: string;
  gap: string;
  leads: string | null;
  related: string[];
  language: Question["language"];
  status: QuestionStatus;
  decision_reason: string | null;
  via: Via;
  created_at: Date;
  decided_at: Date | null;
};

const QUESTION_COLUMNS = "id, question, why, gap, leads, related, language, status, decision_reason, via, created_at, decided_at";

function toQuestion(row: QuestionRow): Question {
  return {
    id: String(row.id),
    question: row.question,
    why: row.why,
    gap: row.gap,
    leads: row.leads,
    related: row.related,
    language: row.language,
    status: row.status,
    reason: row.decision_reason,
    via: row.via,
    createdAt: row.created_at.toISOString(),
    decidedAt: iso(row.decided_at),
  };
}

/**
 * Same transaction shape as `createSubmission`: the user's row is locked, then a replayed `requestId`, then
 * the same question asked before by this reader, then the pending and the daily quota. The caller has checked
 * the fields; the table's CHECKs hold the same bounds.
 */
export async function createQuestion(
  db: Pool,
  input: {
    userId: string;
    question: string;
    why: string;
    gap: string;
    leads: string | null;
    related: string[];
    language: Question["language"];
    via: Via;
    apiKeyId?: string | null;
    requestId?: string | null;
  },
): Promise<QuestionResult> {
  const key = questionKey(input.question);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query('SELECT 1 FROM app."user" WHERE id = $1 FOR UPDATE', [input.userId]);
    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return { result: "no_user" };
    }
    if (input.requestId) {
      const replay = await client.query<QuestionRow>(
        `SELECT ${QUESTION_COLUMNS} FROM app.questions WHERE user_id = $1 AND request_id = $2`,
        [input.userId, input.requestId],
      );
      if (replay.rows[0]) {
        await client.query("COMMIT");
        return { result: "replayed", question: toQuestion(replay.rows[0]) };
      }
    }
    const existing = await client.query<QuestionRow>(
      `SELECT ${QUESTION_COLUMNS} FROM app.questions WHERE user_id = $1 AND question_key = $2`,
      [input.userId, key],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { result: "duplicate", question: toQuestion(existing.rows[0]) };
    }
    const used = await quota(client, "questions", input.userId);
    const refused: Limited | null =
      used.pending >= QUESTION_PENDING_LIMIT ? { result: "limit", scope: "pending", limit: QUESTION_PENDING_LIMIT }
      : used.today >= QUESTION_DAILY_LIMIT ? { result: "limit", scope: "daily", limit: QUESTION_DAILY_LIMIT }
      : null;
    if (refused) {
      await client.query("COMMIT");
      return refused;
    }
    const made = await client.query<QuestionRow>(
      `INSERT INTO app.questions (user_id, question, question_key, why, gap, leads, related, language, via, api_key_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${QUESTION_COLUMNS}`,
      [input.userId, input.question, key, input.why, input.gap, input.leads, input.related, input.language, input.via,
        input.apiKeyId ?? null, input.requestId ?? null],
    );
    await client.query("COMMIT");
    return { result: "created", question: toQuestion(made.rows[0]) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The user's questions, newest first, at most `limit`. */
export async function listQuestions(db: Pool, userId: string, limit = 50): Promise<Question[]> {
  const { rows } = await db.query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM app.questions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map(toQuestion);
}

export type AdminQuestion = Question & { name: string; email: string; decidedBy: string | null };

/** Pending questions oldest first; decided ones newest first, at most 200. */
export async function adminQuestions(db: Pool, view: "pending" | "decided"): Promise<AdminQuestion[]> {
  const pending = view === "pending";
  const { rows } = await db.query<QuestionRow & { name: string; email: string; decided_by_email: string | null }>(
    `SELECT ${QUESTION_COLUMNS.split(", ").map((c) => `q.${c}`).join(", ")}, u.name, u.email, d.email AS decided_by_email
       FROM app.questions q
       JOIN app."user" u ON u.id = q.user_id
       LEFT JOIN app."user" d ON d.id = q.decided_by
      WHERE ${pending ? "q.status = 'pending'" : "q.status <> 'pending'"}
      ORDER BY ${pending ? "q.created_at, q.id" : "q.decided_at DESC, q.id DESC"}
      ${pending ? "" : `LIMIT ${MAX_DECIDED_GROUPS}`}`,
  );
  return rows.map((row) => ({ ...toQuestion(row), name: row.name, email: row.email, decidedBy: row.decided_by_email }));
}

/** Decides one pending question; 0 when it was decided already or does not exist. */
export async function decideQuestion(
  db: Pool,
  input: { id: string; decision: "accepted" | "rejected"; reason: string | null; adminId: string },
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE app.questions SET status = $1, decided_by = $2, decision_reason = $3, decided_at = now()
      WHERE id = $4 AND status = 'pending'`,
    [input.decision, input.adminId, input.decision === "rejected" ? input.reason : null, input.id],
  );
  return rowCount ?? 0;
}

/* ---------- API keys (Issue #5) ---------- */

/** Keys a reader may hold at once; revoked keys do not count. */
export const MAX_ACTIVE_KEYS = 5;

/** `sag_` and 32 base64url characters (24 random bytes). */
export const KEY_PATTERN = /^sag_[A-Za-z0-9_-]{32}$/;

export type ApiKey = {
  id: string;
  name: string;
  /** The first 12 characters, enough to recognise a key; the rest is never stored. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Requests made with this key, of each kind. */
  questions: number;
  accounts: number;
};

/** A new secret, from the platform's cryptographic generator (Web Crypto, a global in Node). */
export function newKeySecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `sag_${Buffer.from(bytes).toString("base64url")}`;
}

/** SHA-256 of the secret, hex. A key is long and random, so a plain hash is enough to look it up by. */
export async function hashKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Buffer.from(digest).toString("hex");
}

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  questions: number;
  accounts: number;
};

const KEY_SELECT = `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at,
       (SELECT count(*)::int FROM app.questions q WHERE q.api_key_id = k.id) AS questions,
       (SELECT count(*)::int FROM app.submissions s WHERE s.api_key_id = k.id) AS accounts
  FROM app.api_keys k`;

function toKey(row: KeyRow): ApiKey {
  return {
    id: String(row.id),
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    questions: row.questions,
    accounts: row.accounts,
  };
}

/** Makes a key. The secret is in the answer and nowhere else: only its hash is stored. */
export async function createKey(
  db: Pool,
  input: { userId: string; name: string },
): Promise<{ result: "created"; key: ApiKey; secret: string } | { result: "limit"; limit: number } | { result: "no_user" }> {
  const secret = newKeySecret();
  const hash = await hashKey(secret);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query('SELECT 1 FROM app."user" WHERE id = $1 FOR UPDATE', [input.userId]);
    if (locked.rows.length === 0) {
      await client.query("ROLLBACK");
      return { result: "no_user" };
    }
    const active = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM app.api_keys WHERE user_id = $1 AND revoked_at IS NULL",
      [input.userId],
    );
    if (active.rows[0].n >= MAX_ACTIVE_KEYS) {
      await client.query("COMMIT");
      return { result: "limit", limit: MAX_ACTIVE_KEYS };
    }
    const made = await client.query<{ id: string }>(
      "INSERT INTO app.api_keys (user_id, name, prefix, secret_hash) VALUES ($1, $2, $3, $4) RETURNING id",
      [input.userId, input.name, secret.slice(0, 12), hash],
    );
    const { rows } = await client.query<KeyRow>(`${KEY_SELECT} WHERE k.id = $1`, [made.rows[0].id]);
    await client.query("COMMIT");
    return { result: "created", key: toKey(rows[0]), secret };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The user's keys, active first and then revoked, newest first within each; revoked ones are kept for the record. */
export async function listKeys(db: Pool, userId: string): Promise<ApiKey[]> {
  const { rows } = await db.query<KeyRow>(
    `${KEY_SELECT} WHERE k.user_id = $1 ORDER BY (k.revoked_at IS NULL) DESC, k.created_at DESC, k.id DESC`,
    [userId],
  );
  return rows.map(toKey);
}

/** Revokes one of the user's active keys; false when it is not theirs, does not exist, or is revoked already. */
export async function revokeKey(db: Pool, userId: string, keyId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE app.api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    [keyId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Who a presented secret belongs to, and the key's id; null when it is malformed, unknown or revoked, or
 * its reader is gone. A successful lookup records the use.
 */
export async function keyOwner(db: Pool, secret: string): Promise<{ userId: string; keyId: string } | null> {
  if (!KEY_PATTERN.test(secret)) return null;
  const { rows } = await db.query<{ id: string; user_id: string }>(
    `UPDATE app.api_keys k SET last_used_at = now()
       FROM app."user" u
      WHERE k.secret_hash = $1 AND k.revoked_at IS NULL AND u.id = k.user_id
      RETURNING k.id, k.user_id`,
    [await hashKey(secret)],
  );
  return rows[0] ? { userId: rows[0].user_id, keyId: String(rows[0].id) } : null;
}

export type QuotaUse = { pending: number; pendingLimit: number; today: number; dailyLimit: number };
export type Usage = { questions: QuotaUse; accounts: QuotaUse; resetsAt: string };

/** The reader's use of both quotas, counted the way the submits count it. */
export async function usage(db: Pool, userId: string): Promise<Usage> {
  const client = await db.connect();
  try {
    const [questions, accounts] = [await quota(client, "questions", userId), await quota(client, "submissions", userId)];
    const { rows } = await client.query<{ resets_at: Date }>("SELECT date_trunc('day', now(), 'UTC') + interval '1 day' AS resets_at");
    return {
      questions: { ...questions, pendingLimit: QUESTION_PENDING_LIMIT, dailyLimit: QUESTION_DAILY_LIMIT },
      accounts: { ...accounts, pendingLimit: PENDING_LIMIT, dailyLimit: ACCOUNT_DAILY_LIMIT },
      resetsAt: rows[0].resets_at.toISOString(),
    };
  } finally {
    client.release();
  }
}
