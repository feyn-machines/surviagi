import { rateLimit } from "./api";
import { appEnabled } from "./app-config";
import {
  createQuestion,
  createSubmission,
  keyOwner,
  listQuestions,
  listSubmissions,
  questionKey,
  usage,
  type Limited,
  type Question,
  type Submission,
} from "./app-store";
import { appPool } from "./auth";
import { normalizeHandle, OWNER_KINDS, type OwnerKind } from "./handles";
import { normalizeLanguage, type Language } from "./i18n";
import { absoluteUrl } from "./seo";
import {
  DEFAULT_RESULTS,
  isRecordId,
  MAX_QUERY,
  MAX_RESULTS,
  publishedQuestion,
  rankedSearch,
  record,
  RECORD_TYPES,
  type RecordType,
} from "./agent-search";
import { sources } from "./snapshot";
import { EDITORIAL_STATUSES, getEditorialArticleRecord, parseEditorialRevisionId, searchEditorialArticles } from "./editorial-agent";

/**
 * The agent tools (Issue #5), shared by the MCP endpoints and the plain HTTP API so the two cannot drift.
 * Reading is open: no sign-in, no key, and a key that is sent, wrong or revoked is ignored.
 * Submitting needs the reader's API key and only ever registers a request for review: nothing here calls a
 * model, starts a crawl or publishes anything.
 */

export type Outcome =
  | { ok: true; value: Record<string, unknown>; cacheable?: boolean }
  | { ok: false; status: number; error: string; message: string; extra?: Record<string, unknown> };

const fail = (status: number, error: string, message: string, extra?: Record<string, unknown>): Outcome => ({
  ok: false, status, error, message, ...(extra ? { extra } : {}),
});
const ok = (value: Record<string, unknown>, cacheable?: boolean): Outcome => ({ ok: true, value, ...(cacheable === undefined ? {} : { cacheable }) });

/** Anonymous reads per client address per minute. Behind Cloudflare the address is cf-connecting-ip. */
export const READ_LIMIT_PER_MINUTE = 60;
/** Submit calls per key per hour, on top of the per-reader quotas, to stop a looping agent early. */
export const SUBMIT_CALLS_PER_HOUR = 60;

export function clientAddress(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "direct";
}

export function readAllowed(request: Request): boolean {
  return rateLimit(`agent-read:${clientAddress(request)}`, READ_LIMIT_PER_MINUTE, 60_000);
}

export const RATE_MESSAGE = `Too many requests: at most ${READ_LIMIT_PER_MINUTE} reads a minute from one address. Wait a minute and retry.`;

/**
 * The secret of `Authorization: Bearer <key>`; null only when no Authorization header is sent. Any other
 * header value comes back as it is, so it is refused as an invalid key rather than as a missing one.
 */
export function bearer(request: Request): string | null {
  const header = request.headers.get("authorization")?.trim();
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : header;
}

type Args = Record<string, unknown>;

/** A string argument, trimmed, within `min`..`max` characters (code points), free of NUL; `undefined` when absent. */
function text(args: Args, name: string, min: number, max: number, required: boolean): { ok: true; value: string | null } | { ok: false; message: string } {
  const value = args[name];
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return required ? { ok: false, message: `\`${name}\` is required.` } : { ok: true, value: null };
  }
  if (typeof value !== "string" || value.includes("\u0000")) return { ok: false, message: `\`${name}\` must be text.` };
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < min || length > max) return { ok: false, message: `\`${name}\` must be ${min}-${max} characters; it is ${length}.` };
  return { ok: true, value: trimmed };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;

function languageArg(args: Args): Language | null | undefined {
  if (args.language === undefined || args.language === null) return undefined;
  return normalizeLanguage(args.language);
}

function requestIdArg(args: Args): { ok: true; value: string | null } | { ok: false; message: string } {
  const value = args.request_id;
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    return { ok: false, message: "`request_id` must be 8-64 characters of letters, digits and . _ : -" };
  }
  return { ok: true, value };
}

export async function runSearch(args: Args): Promise<Outcome> {
  const query = text(args, "query", 1, MAX_QUERY, true);
  if (!query.ok) return fail(400, "invalid", query.message);
  let limit = DEFAULT_RESULTS;
  if (args.limit !== undefined && args.limit !== null) {
    const n = typeof args.limit === "string" ? Number(args.limit) : args.limit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_RESULTS) {
      return fail(400, "invalid", `\`limit\` must be a whole number from 1 to ${MAX_RESULTS}.`);
    }
    limit = n;
  }
  let types: RecordType[] | undefined;
  if (args.types !== undefined && args.types !== null) {
    const list = typeof args.types === "string" ? args.types.split(",").map((t) => t.trim()).filter(Boolean) : args.types;
    if (!Array.isArray(list) || list.some((t) => !(RECORD_TYPES as readonly unknown[]).includes(t))) {
      return fail(400, "invalid", `\`types\` must be a list of: ${RECORD_TYPES.join(", ")}.`);
    }
    types = list.length ? list as RecordType[] : undefined;
  }
  for (const name of ["from", "to"] as const) {
    const value = args[name];
    if (value !== undefined && value !== null && (typeof value !== "string" || !DATE.test(value))) {
      return fail(400, "invalid", `\`${name}\` must be a date written YYYY-MM-DD.`);
    }
  }
  const language = languageArg(args);
  if (language === null) return fail(400, "invalid", "`language` must be en or zh-CN.");
  let status: "approved" | "preview" | undefined;
  if (args.status !== undefined && args.status !== null) {
    if (typeof args.status !== "string" || !(EDITORIAL_STATUSES as readonly string[]).includes(args.status)) {
      return fail(400, "invalid", `\`status\` must be one of: ${EDITORIAL_STATUSES.join(", ")}.`);
    }
    status = args.status as "approved" | "preview";
  }
  const selectedTypes = types ?? [...RECORD_TYPES];
  const includeArticles = selectedTypes.includes("article");
  const found = rankedSearch({
    query: query.value as string,
    limit: MAX_RESULTS,
    types: selectedTypes.filter((type) => type !== "article"),
    from: (args.from as string | undefined) ?? null,
    to: (args.to as string | undefined) ?? null,
    language,
  });
  let articles: Awaited<ReturnType<typeof searchEditorialArticles>> | null = null;
  if (includeArticles) {
    try {
      articles = await searchEditorialArticles({
        query: query.value as string,
        limit: MAX_RESULTS,
        language: language ?? "en",
        from: (args.from as string | undefined) ?? null,
        to: (args.to as string | undefined) ?? null,
        status,
      });
    } catch (error) {
      console.error(`[agent] editorial search failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return fail(503, "unavailable", "Public article search is unavailable right now. Try again later.");
    }
  }
  const combined = [
    ...found.results,
    ...(articles?.results ?? []),
  ].sort((a, b) => b.score - a.score ||
    Number(b.result.type === "article" && "status" in b.result && (b.result.status === "approved" || b.result.status === "approved_historical")) - Number(a.result.type === "article" && "status" in a.result && (a.result.status === "approved" || a.result.status === "approved_historical")) ||
    (b.result.date ?? "").localeCompare(a.result.date ?? "") || a.result.id.localeCompare(b.result.id));
  const results = combined.slice(0, limit).map(({ result }) => result);
  const available = articles?.available ?? null;
  const total = found.total + (articles?.total ?? 0);
  return ok({
    query: query.value,
    total,
    results,
    release: found.release,
    content_kinds: found.content_kinds,
    editorial_articles: includeArticles ? { available, count: articles?.total ?? 0 } : null,
    note: results.length === 0
      ? `Nothing in the published data matches. A search that finds nothing starts no research or collection; if the question matters, a signed-in reader can submit it with submit_question.${includeArticles && !available ? " Editorial articles are also unavailable because the public article store is not configured." : ""}`
      : `Results are published records. Article results include their exact revision, publication status, sources and evidence cutoff. Cite each result's url; quote sources, not our summaries.${includeArticles && !available ? " Editorial articles are unavailable because the public article store is not configured." : ""}`,
  }, !includeArticles);
}

export async function runRecord(args: Args): Promise<Outcome> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return fail(400, "invalid", "`id` is required.");
  const language = languageArg(args);
  if (language === null) return fail(400, "invalid", "`language` must be en or zh-CN.");
  const editorialRevision = parseEditorialRevisionId(id);
  if (editorialRevision) {
    try {
      const found = await getEditorialArticleRecord(editorialRevision.articleId, editorialRevision.version, language ?? "en");
      return found ? ok(found, false) : fail(404, "not_found", "No public article revision with this id is available. It may have been withdrawn; search again.");
    } catch (error) {
      console.error(`[agent] editorial record read failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return fail(503, "unavailable", "Public article reading is unavailable right now. Try again later.");
    }
  }
  if (!isRecordId(id)) return fail(400, "invalid", "`id` must be an id returned by search (an update, question, evidence or article revision id).");
  const found = record(id, language ?? "en");
  if (!found) return fail(404, "not_found", "The loaded data release holds no record with this id. Ids of earlier releases may be gone; search again.");
  return ok(found, true);
}

type Owner = { userId: string; keyId: string };

/** The reader behind the request's key, or the refusal to send. Never consulted for reads. */
export async function authenticate(request: Request): Promise<{ ok: true; owner: Owner } | { ok: false; outcome: Outcome }> {
  if (!appEnabled()) return { ok: false, outcome: fail(503, "unavailable", "Submissions are not available on this server.") };
  const secret = bearer(request);
  if (!secret) {
    return {
      ok: false,
      outcome: fail(401, "missing_key", `Submitting needs a SurviAGI API key, sent as \`Authorization: Bearer <key>\`. A signed-in reader makes one at ${absoluteUrl("en", "/agents")}#keys. Searching and reading need no key.`),
    };
  }
  let owner: Owner | null;
  try {
    owner = await keyOwner(appPool(), secret);
  } catch (error) {
    console.error(`[agent] key lookup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return { ok: false, outcome: fail(503, "unavailable", "Submissions are unavailable right now. Try again later.") };
  }
  if (!owner) return { ok: false, outcome: fail(401, "invalid_key", "This API key is not valid: it is unknown, mistyped or revoked. Make a new one on the agents page.") };
  if (!rateLimit(`agent-submit:${owner.keyId}`, SUBMIT_CALLS_PER_HOUR, 3600_000)) {
    return { ok: false, outcome: fail(429, "rate", `Too many calls with this key: at most ${SUBMIT_CALLS_PER_HOUR} an hour.`) };
  }
  return { ok: true, owner };
}

const limited = (refused: Limited, what: "questions" | "account suggestions"): Outcome =>
  fail(429, "quota", refused.scope === "pending"
    ? `You have ${refused.limit} ${what} waiting for review, the most allowed. Wait for decisions before submitting more.`
    : `You have submitted ${refused.limit} new ${what} today (UTC), the most allowed. Try again tomorrow.`,
  { result: "limit", scope: refused.scope, limit: refused.limit });

const questionView = (q: Question) => ({
  id: `question:${q.id}`,
  status: q.status,
  question: q.question,
  submitted_at: q.createdAt,
  decided_at: q.decidedAt,
  reason: q.reason,
  via: q.via,
});

const QUESTION_PRIVATE = "Submitted questions are private to you and the project's reviewers; one is never published as it was written.";

export async function runSubmitQuestion(owner: Owner, args: Args): Promise<Outcome> {
  const question = text(args, "question", 8, 300, true);
  if (!question.ok) return fail(400, "invalid", question.message);
  const why = text(args, "why_it_matters", 20, 1000, true);
  if (!why.ok) return fail(400, "invalid", why.message);
  const gap = text(args, "evidence_gap", 10, 1000, true);
  if (!gap.ok) return fail(400, "invalid", gap.message);
  const leads = text(args, "leads", 1, 1000, false);
  if (!leads.ok) return fail(400, "invalid", leads.message);
  const requestId = requestIdArg(args);
  if (!requestId.ok) return fail(400, "invalid", requestId.message);
  let related: string[] = [];
  if (args.related_record_ids !== undefined && args.related_record_ids !== null) {
    const list = args.related_record_ids;
    if (!Array.isArray(list) || list.length > 10 || list.some((id) => typeof id !== "string" || !isRecordId(id))) {
      return fail(400, "invalid", "`related_record_ids` must be at most 10 ids returned by search.");
    }
    related = [...new Set(list as string[])];
  }
  const q = question.value as string;
  if (!/[\p{L}]/u.test(q) || /^https?:\/\/\S+$/i.test(q)) return fail(400, "invalid", "`question` must be a question in words, not only a link.");
  if (questionKey(q) === questionKey(why.value as string)) return fail(400, "invalid", "`why_it_matters` must say why the question matters, not repeat it.");
  const given = languageArg(args);
  if (given === null) return fail(400, "invalid", "`language` must be en or zh-CN.");
  const language: Language = given ?? (/\p{Script=Han}/u.test(q) ? "zh-CN" : "en");

  const published = publishedQuestion(questionKey, q);
  if (published) {
    return ok({
      result: "published",
      record_id: published.topic_id,
      url: absoluteUrl(language, `/topics/${published.slug}`),
      message: "This question is already published as a topic; read it with get_record instead of submitting it.",
    });
  }
  const made = await createQuestion(appPool(), {
    userId: owner.userId, question: q, why: why.value as string, gap: gap.value as string, leads: leads.value,
    related, language, via: "api", apiKeyId: owner.keyId, requestId: requestId.value,
  });
  switch (made.result) {
    case "no_user":
      return fail(401, "invalid_key", "The reader this key belongs to no longer exists.");
    case "limit":
      return limited(made, "questions");
    case "created":
      return ok({ result: "created", ...questionView(made.question), message: `Registered for review. ${QUESTION_PRIVATE} Review decides whether the project researches it; nothing runs automatically.` });
    case "duplicate":
      return ok({ result: "duplicate", ...questionView(made.question), message: "You submitted this question before; nothing new was registered." });
    case "replayed":
      return ok({ result: "replayed", ...questionView(made.question), message: "This request_id was used before; this is what that request registered." });
  }
}

/** Where an account request stands. Approval is not identity confirmation, and none of these start collection. */
function lifecycle(s: Submission) {
  return {
    stage: s.status === "approved" && s.importedAt ? "approved_handed_to_local_import" : s.status === "pending" ? "pending_review" : s.status,
    note: "Stages are separate: submitted, approved by a reviewer, identity confirmed, monitoring enabled. A request or an approval does not confirm identity or start collection.",
  };
}

const accountView = (s: Submission) => ({
  id: `account:${s.id}`,
  account: `@${s.handle}`,
  kind: s.ownerKind,
  status: s.status,
  submitted_at: s.createdAt,
  decided_at: s.decidedAt,
  reason: s.reason,
  via: s.via,
  lifecycle: lifecycle(s),
});

export async function runSuggestAccount(owner: Owner, args: Args): Promise<Outcome> {
  const handle = normalizeHandle(args.account);
  if (!handle) return fail(400, "invalid", "`account` must be one X account: @name, name, or https://x.com/name.");
  if (typeof args.kind !== "string" || !(OWNER_KINDS as readonly string[]).includes(args.kind)) {
    return fail(400, "invalid", "`kind` must be person or organization.");
  }
  const reason = text(args, "reason", 1, 280, true);
  if (!reason.ok) return fail(400, "invalid", reason.message);
  const field = text(args, "field", 1, 80, false);
  if (!field.ok) return fail(400, "invalid", field.message);
  const requestId = requestIdArg(args);
  if (!requestId.ok) return fail(400, "invalid", requestId.message);

  if (sources().some((source) => (source.platform ?? "x") === "x" && source.handle.toLowerCase() === handle.key)) {
    return ok({ result: "monitored", account: `@${handle.handle}`, message: "This account is already monitored; nothing was registered." });
  }
  const made = await createSubmission(appPool(), {
    userId: owner.userId, handle: handle.handle, key: handle.key, ownerKind: args.kind as OwnerKind, note: reason.value,
    field: field.value, via: "api", apiKeyId: owner.keyId, requestId: requestId.value,
  });
  switch (made.result) {
    case "no_user":
      return fail(401, "invalid_key", "The reader this key belongs to no longer exists.");
    case "limit":
      return limited(made, "account suggestions");
    case "created":
      return ok({ result: "created", ...accountView(made.submission), message: "Registered for review. It does not start monitoring." });
    case "duplicate":
      return ok({ result: "duplicate", ...accountView(made.submission), message: "You suggested this account before; nothing new was registered." });
    case "replayed":
      return ok({ result: "replayed", ...accountView(made.submission), message: "This request_id was used before; this is what that request registered." });
  }
}

export async function runMySubmissions(owner: Owner): Promise<Outcome> {
  const db = appPool();
  const [use, questions, accounts] = await Promise.all([usage(db, owner.userId), listQuestions(db, owner.userId, 20), listSubmissions(db, owner.userId)]);
  return ok({
    quota: {
      questions: { pending: use.questions.pending, pending_limit: use.questions.pendingLimit, today: use.questions.today, daily_limit: use.questions.dailyLimit },
      accounts: { pending: use.accounts.pending, pending_limit: use.accounts.pendingLimit, today: use.accounts.today, daily_limit: use.accounts.dailyLimit },
      day: "UTC",
      resets_at: use.resetsAt,
      note: "Quotas count per reader: every key of yours and the site's own forms share them.",
    },
    questions: questions.map(questionView),
    accounts: accounts.slice(0, 20).map(accountView),
  });
}

/** Runs a submit tool behind the key check; a database failure becomes a plain 503. */
export async function withOwner(request: Request, run: (owner: Owner) => Promise<Outcome>): Promise<Outcome> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.outcome;
  try {
    return await run(auth.owner);
  } catch (error) {
    console.error(`[agent] submit failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return fail(503, "unavailable", "Submissions are unavailable right now. Try again later.");
  }
}

/* ---------- Tool definitions, in MCP's form ---------- */

const LANGUAGE_SCHEMA = { type: "string", enum: ["en", "zh-CN"], description: "Language of the page links and labels. Default en." };
const REQUEST_ID_SCHEMA = {
  type: "string",
  pattern: "^[A-Za-z0-9._:-]{8,64}$",
  description: "Your own id for this attempt (e.g. a UUID). Sending the same id again returns the first result instead of registering twice, so retries are safe.",
};

export const READ_TOOLS = [
  {
    name: "search",
    title: "Search SurviAGI",
    description:
      "Search SurviAGI's published records of AI progress: updates, questions, evidence readings, and public bilingual editorial articles. " +
      "Use types to select article; articles can be filtered by status approved or preview. Results include exact revision IDs, sources, " +
      "evidence cutoff and the true publication status. A preview is public but not approved. Search returns only public article pointers; " +
      "private drafts and reviewer identities or notes are never exposed. Summaries and levels are machine-proposed and unreviewed; quote sources, cite the url. " +
      "Read one record in full with get_record. No sign-in or key needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: MAX_QUERY, description: "What to look for, in English or Chinese: a company, model, kind of work, job or question." },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, default: DEFAULT_RESULTS, description: "How many records to return." },
        types: { type: "array", items: { type: "string", enum: [...RECORD_TYPES] }, description: "Only these kinds of record. Default all, including public articles." },
        status: { type: "string", enum: [...EDITORIAL_STATUSES], description: "For articles: approved or public preview. Omit to include both; ignored for other record types." },
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Only records dated on or after this day (YYYY-MM-DD)." },
        to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Only records dated on or before this day (YYYY-MM-DD)." },
        language: LANGUAGE_SCHEMA,
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: "get_record",
    title: "Read a SurviAGI record",
    description:
      "Read one published record by the id search returned: a public article revision returns its full Markdown, bilingual link, sources, evidence cutoff, exact version and real approval scope/status; " +
      "an update with its source posts and every reading of it; " +
      "a question with its answer options, the posts that argued them (with short quotes of the posts' own words) and the " +
      "updates that weigh on them; or one evidence reading with its level, tier, rationale and sources. Each text says whether " +
      "it is our summary or the source's words. The full text of source posts is not published: open the source URLs. No key needed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 260, description: "An id from search: ev-…, topic:…, evidence:… or article:<slug>:v<version>." },
        language: LANGUAGE_SCHEMA,
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
] as const;

export const SUBMIT_TOOLS = [
  {
    name: "submit_question",
    title: "Submit a research question",
    description:
      "Ask SurviAGI to research a question, as a request for review. Needs the reader's API key. Search first: if the question " +
      "is already published, read it instead. A good question is specific, about AI doing real work (a job, a kind of business, " +
      "a capability), says why it matters and what the published records lack, and gives leads (sources, accounts, dates). " +
      "Write it yourself from the conversation. The question stays private; a reviewer decides whether it is researched. " +
      "Returns an id and the status (pending). Nothing is researched automatically.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 8, maxLength: 300, description: "The question, one sentence." },
        why_it_matters: { type: "string", minLength: 20, maxLength: 1000, description: "Why the answer matters, and to whom." },
        evidence_gap: { type: "string", minLength: 10, maxLength: 1000, description: "What the published records you searched do not answer." },
        leads: { type: "string", maxLength: 1000, description: "Sources, accounts, dates or links that could help." },
        related_record_ids: { type: "array", items: { type: "string" }, maxItems: 10, description: "Ids of records you found while searching." },
        language: LANGUAGE_SCHEMA,
        request_id: REQUEST_ID_SCHEMA,
      },
      required: ["question", "why_it_matters", "evidence_gap"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "suggest_account",
    title: "Suggest an X account to monitor",
    description:
      "Suggest a public X account that SurviAGI should collect from, as a request for review. Needs the reader's API key. " +
      "Give the account, whether it is a person or an organization, why it is worth following and its field. An account " +
      "already monitored, or suggested by you before, is reported as such. Approval is not identity confirmation, and no " +
      "suggestion starts collection by itself.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", minLength: 1, maxLength: 120, description: "@name, name, or https://x.com/name" },
        kind: { type: "string", enum: [...OWNER_KINDS], description: "person or organization" },
        reason: { type: "string", minLength: 1, maxLength: 280, description: "Why this account is worth monitoring." },
        field: { type: "string", maxLength: 80, description: "The field it covers, e.g. 'AI coding agents'." },
        request_id: REQUEST_ID_SCHEMA,
      },
      required: ["account", "kind", "reason"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "my_submissions",
    title: "My submissions and quota",
    description: "The key holder's recent questions and account suggestions with their review status, and how much of today's quota is left. Needs the reader's API key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
] as const;

export type ToolName = (typeof READ_TOOLS)[number]["name"] | (typeof SUBMIT_TOOLS)[number]["name"];

/** Runs one tool by name. `submit` tools are refused on the public endpoint, before any key is looked at. */
export async function runTool(request: Request, name: string, args: Args, scope: "public" | "submit"): Promise<Outcome | null> {
  switch (name) {
    case "search":
      return runSearch(args);
    case "get_record":
      return runRecord(args);
    case "submit_question":
    case "suggest_account":
    case "my_submissions":
      if (scope !== "submit") return null;
      return withOwner(request, (owner) =>
        name === "submit_question" ? runSubmitQuestion(owner, args)
        : name === "suggest_account" ? runSuggestAccount(owner, args)
        : runMySubmissions(owner));
    default:
      return null;
  }
}
