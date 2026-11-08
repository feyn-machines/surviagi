import { knowledgeAgent } from './knowledge/runtime';
import { KNOWLEDGE_SEARCH_TOOL } from './knowledge/agent';
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
  DEFAULT_RECORD_TYPES,
  type RecordType,
  releaseInfo,
  versionsInfo,
} from "./agent-search";
import { EVIDENCE_ORDER, observationsPublished, sources, type EvidenceType } from "./snapshot";
import {
  candidateView,
  conceptSummary,
  decodeCursor,
  DEFAULT_OBSERVATIONS,
  DEFAULT_CHANGES,
  DIRECTIONS,
  encodeCursor,
  filterObservations,
  MAX_OBSERVATIONS,
  OBSERVATION_CONTENT,
  observationCounts,
  observationSummary,
  ORDERS,
  OUTCOMES,
  resolveConcept,
  REVIEW_STATES,
  sortObservations,
  type ObservationFilter,
} from "./agent-observations";
import { editorialChangesSince, EDITORIAL_STATUSES, getEditorialArticleRecord, parseEditorialRevisionId, searchEditorialArticles } from "./editorial-agent";
import { CHANGES_NOTE, parseSince, releaseChanges, type Since } from "./agent-changes";

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
  const selectedTypes = types ?? [...DEFAULT_RECORD_TYPES];
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
    aliases: found.aliases,
    release: found.release,
    versions: versionsInfo(),
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
  if (id.startsWith("knowledge:")) return knowledgeAgent.get({ ...args, id });
  if (args.revision !== undefined) return fail(400, "invalid", "revision is only supported for knowledge records.");
  const editorialRevision = parseEditorialRevisionId(id);
  if (editorialRevision) {
    try {
      const found = await getEditorialArticleRecord(editorialRevision.articleId, editorialRevision.version, language ?? "en");
      return found ? ok({ ...found, versions: versionsInfo() }, false) : fail(404, "not_found", "No public article revision with this id is available. It may have been withdrawn; search again.");
    } catch (error) {
      console.error(`[agent] editorial record read failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return fail(503, "unavailable", "Public article reading is unavailable right now. Try again later.");
    }
  }
  if (!isRecordId(id)) return fail(400, "invalid", "`id` must be an id returned by search or query_observations (an update, question, observation, evidence, article revision or oaw:market:/oaw:occupation:/model: catalog id, or x: account key).");
  const found = record(id, language ?? "en");
  if (!found) return fail(404, "not_found", "The loaded data release holds no record with this id. Ids of earlier releases may be gone; search again.");
  return ok(found, true);
}

/** A list argument: an array, or one comma-separated string as a query parameter gives it. */
function listArg<T extends string>(args: Args, name: string, allowed: readonly T[]): { ok: true; value: T[] | undefined } | { ok: false; message: string } {
  const value = args[name];
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  const list = typeof value === "string" ? value.split(",").map((v) => v.trim()).filter(Boolean) : value;
  if (!Array.isArray(list) || list.some((v) => !(allowed as readonly unknown[]).includes(v))) {
    return { ok: false, message: `\`${name}\` must be a list of: ${allowed.join(", ")}.` };
  }
  return { ok: true, value: list.length ? [...new Set(list as T[])] : undefined };
}

type Concept = Extract<ReturnType<typeof resolveConcept>, { ok: true }>["concept"];

/** An occupation or market argument, resolved; an unknown or ambiguous name is a 404 listing what matched. */
function conceptArg(args: Args, kind: "occupation" | "market", language: Language): { ok: true; value: Concept | undefined } | { ok: false; outcome: Outcome } {
  const given = text(args, kind, 1, 200, false);
  if (!given.ok) return { ok: false, outcome: fail(400, "invalid", given.message) };
  if (given.value === null) return { ok: true, value: undefined };
  const found = resolveConcept(kind, given.value);
  if (found.ok) return { ok: true, value: found.concept };
  return {
    ok: false,
    outcome: fail(404, "not_found", found.candidates.length
      ? `Several ${kind}s match "${given.value}"; call again with one of the candidates' ids.`
      : `No ${kind} matches "${given.value}". Give its id, the slug in its page address, its name in English or Chinese, or another name it is known by ("software engineer", "程序员").`,
    { candidates: found.candidates.map((c) => candidateView(c, language)) }),
  };
}

function dateArgs(args: Args): string | null {
  for (const name of ["from", "to"] as const) {
    const value = args[name];
    if (value !== undefined && value !== null && (typeof value !== "string" || !DATE.test(value))) return `\`${name}\` must be a date written YYYY-MM-DD.`;
  }
  return null;
}

const SINCE_HELP = "a data release id (versions.data of an earlier answer, e.g. 20261102T081500Z-1a2b3c4d), a date YYYY-MM-DD (from its start, UTC) or a time with its offset (2026-11-02T08:00:00+08:00)";

/** A moment to look after: a release id, a day or an instant. One in the future is refused. */
function sinceArg(args: Args, name: string, required: boolean): { ok: true; value: Since | null } | { ok: false; outcome: Outcome } {
  const given = text(args, name, 1, 64, required);
  if (!given.ok) return { ok: false, outcome: fail(400, "invalid", `${given.message} Give ${SINCE_HELP}.`) };
  if (given.value === null) return { ok: true, value: null };
  const since = parseSince(given.value);
  if (!since) return { ok: false, outcome: fail(400, "invalid", `\`${name}\` must be ${SINCE_HELP}.`) };
  if (Date.parse(since.at) > Date.now()) return { ok: false, outcome: fail(400, "invalid", `\`${name}\` is in the future.`) };
  return { ok: true, value: since };
}

const UNPUBLISHED = "This data release does not carry observations yet: counts are unknown, not zero.";

export function runQueryObservations(args: Args): Outcome {
  const language = languageArg(args);
  if (language === null) return fail(400, "invalid", "`language` must be en or zh-CN.");
  const lang = language ?? "en";
  const occupation = conceptArg(args, "occupation", lang);
  if (!occupation.ok) return occupation.outcome;
  const market = conceptArg(args, "market", lang);
  if (!market.ok) return market.outcome;
  const task = text(args, "task", 1, 120, false);
  if (!task.ok) return fail(400, "invalid", task.message);
  const organization = text(args, "organization", 1, 200, false);
  if (!organization.ok) return fail(400, "invalid", organization.message);
  const subject = text(args, "subject", 1, 200, false);
  if (!subject.ok) return fail(400, "invalid", subject.message);
  const evidenceTypes = listArg<EvidenceType>(args, "evidence_types", EVIDENCE_ORDER);
  if (!evidenceTypes.ok) return fail(400, "invalid", evidenceTypes.message);
  const directions = listArg(args, "directions", DIRECTIONS);
  if (!directions.ok) return fail(400, "invalid", directions.message);
  const outcomes = listArg(args, "outcomes", OUTCOMES);
  if (!outcomes.ok) return fail(400, "invalid", outcomes.message);
  const reviewStates = listArg(args, "review_states", REVIEW_STATES);
  if (!reviewStates.ok) return fail(400, "invalid", reviewStates.message);
  const badDate = dateArgs(args);
  if (badDate) return fail(400, "invalid", badDate);
  const recorded = sinceArg(args, "recorded_since", false);
  if (!recorded.ok) return recorded.outcome;
  const order = args.order ?? "strength";
  if (typeof order !== "string" || !(ORDERS as readonly string[]).includes(order)) return fail(400, "invalid", `\`order\` must be one of: ${ORDERS.join(", ")}.`);
  let limit = DEFAULT_OBSERVATIONS;
  if (args.limit !== undefined && args.limit !== null) {
    const n = typeof args.limit === "string" ? Number(args.limit) : args.limit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_OBSERVATIONS) {
      return fail(400, "invalid", `\`limit\` must be a whole number from 1 to ${MAX_OBSERVATIONS}.`);
    }
    limit = n;
  }
  let offset = 0;
  if (args.cursor !== undefined && args.cursor !== null && args.cursor !== "") {
    const decoded = typeof args.cursor === "string" ? decodeCursor(args.cursor) : { ok: false as const, stale: false };
    if (!decoded.ok) {
      return fail(400, "invalid", decoded.stale
        ? "`cursor` belongs to an earlier data release; run the query again without it."
        : "`cursor` must be the next_cursor of an earlier answer.");
    }
    offset = decoded.offset;
  }
  const filter: ObservationFilter = {
    occupation: occupation.value, market: market.value, task: task.value ?? undefined,
    organization: organization.value ?? undefined, subject: subject.value ?? undefined,
    evidenceTypes: evidenceTypes.value, directions: directions.value, outcomes: outcomes.value, reviewStates: reviewStates.value,
    from: (args.from as string | undefined) ?? null, to: (args.to as string | undefined) ?? null,
    recordedSince: recorded.value?.at ?? null,
  };
  const published = observationsPublished();
  const rows = sortObservations(filterObservations(filter), order as (typeof ORDERS)[number]);
  const page = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length ? encodeCursor(offset + limit) : null;
  return ok({
    published,
    filters: {
      occupation: occupation.value ? candidateView(occupation.value, lang) : null,
      market: market.value ? candidateView(market.value, lang) : null,
      task: filter.task ?? null, organization: filter.organization ?? null, subject: filter.subject ?? null,
      evidence_types: filter.evidenceTypes ?? null, directions: filter.directions ?? null, outcomes: filter.outcomes ?? null,
      review_states: filter.reviewStates ?? null, from: filter.from, to: filter.to, recorded_since: filter.recordedSince, order,
    },
    total: published ? rows.length : null,
    counts: published ? observationCounts(rows) : null,
    results: page.map((row) => observationSummary(row, lang)),
    next_cursor: next,
    content: OBSERVATION_CONTENT,
    release: releaseInfo(),
    versions: versionsInfo(),
    note: !published ? UNPUBLISHED
      : rows.length === 0 ? "No published observation matches. That describes what was collected and read, not the work itself; a query starts no research or collection."
      : "Observations are read by a model from collected posts and unreviewed unless review_state says otherwise. Cite each result's url and source urls; quote the sources' words, not the task line. In zh-CN the wording is a machine translation where one exists; quotes stay as written.",
  });
}

export function runSummary(args: Args): Outcome {
  const language = languageArg(args);
  if (language === null) return fail(400, "invalid", "`language` must be en or zh-CN.");
  const lang = language ?? "en";
  const given = (["occupation", "market"] as const).filter((name) => typeof args[name] === "string" && (args[name] as string).trim() !== "");
  if (given.length !== 1) return fail(400, "invalid", "Give exactly one of `occupation` or `market`.");
  const concept = conceptArg(args, given[0], lang);
  if (!concept.ok) return concept.outcome;
  return ok({ ...conceptSummary(concept.value!, lang), content: OBSERVATION_CONTENT, release: releaseInfo(), versions: versionsInfo() });
}

export async function runChanges(args: Args): Promise<Outcome> {
  const language = languageArg(args);
  if (language === null) return fail(400, "invalid", "`language` must be en or zh-CN.");
  const lang = language ?? "en";
  const since = sinceArg(args, "since", true);
  if (!since.ok) return since.outcome;
  const occupation = conceptArg(args, "occupation", lang);
  if (!occupation.ok) return occupation.outcome;
  const market = conceptArg(args, "market", lang);
  if (!market.ok) return market.outcome;
  let limit = DEFAULT_CHANGES;
  if (args.limit !== undefined && args.limit !== null) {
    const n = typeof args.limit === "string" ? Number(args.limit) : args.limit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_OBSERVATIONS) {
      return fail(400, "invalid", `\`limit\` must be a whole number from 1 to ${MAX_OBSERVATIONS}.`);
    }
    limit = n;
  }
  const at = since.value!;
  const changes = releaseChanges({ since: at, occupation: occupation.value, market: market.value, limit, language: lang });
  // Articles are not in data releases and are not mapped to occupations: only an unscoped answer reads them.
  const scoped = !!(occupation.value || market.value);
  let articles: Awaited<ReturnType<typeof editorialChangesSince>> | null = null;
  if (!scoped) {
    try {
      articles = await editorialChangesSince(at.at, lang, limit);
    } catch (error) {
      console.error(`[agent] editorial changes failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return fail(503, "unavailable", "Public article reading is unavailable right now. Try again later.");
    }
  }
  return ok({
    ...changes,
    articles,
    content: OBSERVATION_CONTENT,
    release: releaseInfo(),
    versions: versionsInfo(),
    note: `${changes.observations ? "" : `${UNPUBLISHED} `}${CHANGES_NOTE}${scoped ? " Scoped to one occupation or market: updates and articles are left out (null), as they are not mapped to it." : ""}${articles && !articles.available ? " Editorial articles are unavailable because the public article store is not configured." : ""}`,
  }, scoped);
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
      "Search SurviAGI's published records of AI progress: updates, questions, observations (dated statements that AI did or did not do a piece of work, with their source words) and public bilingual editorial articles (deprecated: evidence readings, only when asked for with types). " +
      "A Chinese query finds English records through the occupation, market and work names they carry in both languages; each result's matched says which field and terms it matched, and title_language whether its title is Chinese. " +
      "Another name of an occupation counts as its name (\"software engineer\", \"码农\" find Software Developers); aliases lists the ones the query used. " +
      "Use types to select article; articles can be filtered by status approved or preview. Results include exact revision IDs, sources, " +
      "evidence cutoff and the true publication status. A preview is public but not approved. Search returns only public article pointers; " +
      "private drafts and reviewer identities or notes are never exposed. Summaries are machine-proposed and unreviewed; quote sources, cite the url. " +
      "Read one record in full with get_record. No sign-in or key needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: MAX_QUERY, description: "What to look for, in English or Chinese: a company, model, kind of work, job or question." },
        limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS, default: DEFAULT_RESULTS, description: "How many records to return." },
        types: { type: "array", items: { type: "string", enum: [...RECORD_TYPES] }, description: "Only these kinds of record. Default: update, question, observation and article. `evidence` (levels from the retired L0–L5 scale) is deprecated and returned only when named here." },
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
      "Read knowledge:* with optional revision (sha256 hash) for the current or exact historical revision, including conditions, sources, full localized text, knowledge commit/index hash and withdrawal generation. Withdrawn records return identity/status/reason only. Legacy records retain their semantics. Read one published record by its exact id. model:<owner>:<slug> reads published model metadata; x:<handle> reads a collected account and identity basis, with source URLs but no post bodies. These link to collection pages and have no Markdown page. Example: {id: model:openai:gpt-4}. Catalog ids (oaw:occupation:… and oaw:market:…, including activity ids) return structured fields, related ids, page links and coverage limits; for example id=oaw:occupation:13-2011.00 with language=zh-CN. Other records: a public article revision returns its full Markdown, bilingual link, sources, evidence cutoff, exact version and real approval scope/status; " +
      "an update with its source posts and every reading of it; " +
      "a question with its answer options, the posts that argued them (with short quotes of the posts' own words) and the " +
      "updates that weigh on them; an observation (obs-…, from query_observations or occupation_summary) with its figures, the source words each was read from, " +
      "who did it, the occupations, tasks and markets it was mapped to and the method that read it (a merged id returns the observation it was merged into); or one evidence reading (deprecated: its level is from the retired L0–L5 scale) with rationale and sources. Each text says whether " +
      "it is our summary or the source's words. The full text of source posts is not published: open the source URLs. No key needed.",
    inputSchema: {
      type: "object",
      properties: {
        revision: { type: "string", pattern: "^sha256:[a-f0-9]{64}$", description: "Exact knowledge revision returned by search_knowledge. Omit for current head; never substituted if missing." },
        id: { type: "string", minLength: 1, maxLength: 260, description: "A knowledge:* id from search_knowledge, or an id from search or query_observations: ev-…, topic:…, obs-…, evidence:…, article:<slug>:v<version>, oaw:occupation:<code>, oaw:market:<slug> (market or activity), model:<owner>:<slug> or x:<handle>." },
        language: LANGUAGE_SCHEMA,
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: "query_observations",
    title: "List SurviAGI observations",
    description:
      "List observations: single dated statements, read from collected posts, that AI did (or did not do) a piece of work, each with what it rests on " +
      "(production_use by a named adopter, measurement or statistic by someone other than the vendor, a practitioner's own_use, a demonstration, a vendor_claim), " +
      "its direction (ai_takes_on, human_still_needed, neutral), its figures with the source words, and source links. " +
      "Filter by occupation or market (id, page slug or name, English or Chinese), task id, organization, product or model, evidence type, direction, outcome, " +
      "review state and date. Returns the counts over everything that matches (the same counts the occupation and market pages show) and one page of rows; " +
      "pass next_cursor back for the next page. Use occupation_summary for one occupation's or market's statistics. Every observation is machine-read and " +
      "unreviewed unless review_state says otherwise; quote the source words and cite the url. No key needed.",
    inputSchema: {
      type: "object",
      properties: {
        occupation: { type: "string", maxLength: 200, description: "An occupation: oaw:occupation:<O*NET code>, the code alone (13-2011.00) or its name (Accountants and Auditors, 会计师与审计师)." },
        market: { type: "string", maxLength: 200, description: "A market (a kind of business): oaw:market:<slug>, the slug alone or its name." },
        task: { type: "string", maxLength: 120, description: "An O*NET task id as observations carry it, e.g. oaw:task:21593." },
        organization: { type: "string", maxLength: 200, description: "Who did it: an organization id (org:anthropic), an actor key (x:handle) or the exact name." },
        subject: { type: "string", maxLength: 200, description: "The product or model used: its key, product id or model id." },
        evidence_types: { type: "array", items: { type: "string", enum: [...EVIDENCE_ORDER] }, description: "Only these evidence types." },
        directions: { type: "array", items: { type: "string", enum: [...DIRECTIONS] }, description: "Only these directions. human_still_needed lists the evidence the other way." },
        outcomes: { type: "array", items: { type: "string", enum: [...OUTCOMES] }, description: "Only these outcomes." },
        review_states: { type: "array", items: { type: "string", enum: [...REVIEW_STATES] }, description: "Only these review states." },
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Only observations said on or after this day (YYYY-MM-DD). An undated observation passes no date filter." },
        to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Only observations said on or before this day (YYYY-MM-DD)." },
        recorded_since: { type: "string", maxLength: 64, description: "Only observations first recorded in the ledger after this: a data release id, a date (from its start, UTC) or a time with offset. changes_since hands this out to page through everything new." },
        order: { type: "string", enum: [...ORDERS], default: "strength", description: "strength: production use and independent measurement first, vendor claims last, as the pages list them; newest: by the date it was said; recorded: last recorded first." },
        limit: { type: "integer", minimum: 1, maximum: MAX_OBSERVATIONS, default: DEFAULT_OBSERVATIONS, description: "Rows per page." },
        cursor: { type: "string", maxLength: 200, description: "next_cursor from the previous page of the same query." },
        language: LANGUAGE_SCHEMA,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: "occupation_summary",
    title: "Evidence statistics of an occupation or market",
    description:
      "The evidence on one occupation (\"will AI take over accountants?\") or one market (\"will AI change call centres as a business?\"): observations counted " +
      "by evidence type, by direction and by outcome, how many were said in the 30 and 90 days before the data date, the strongest observations and those " +
      "pointing the other way, the products and adopters named most, and for an occupation the tasks most observed. The numbers are the ones its page " +
      "shows, as of the data release. A release without observations says so (counts null), and a page with none counts zero. No key needed.",
    inputSchema: {
      type: "object",
      properties: {
        occupation: { type: "string", maxLength: 200, description: "An occupation: oaw:occupation:<O*NET code>, the code alone, its name in English or Chinese, or another name it is known by (\"software engineer\", \"程序员\")." },
        market: { type: "string", maxLength: 200, description: "A market: oaw:market:<slug>, the slug alone or its name. Give this or occupation, not both." },
        language: LANGUAGE_SCHEMA,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: "changes_since",
    title: "What is new since a release or a date",
    description:
      "What changed since an earlier data release (pass versions.data of an earlier answer) or a date: observations first recorded since then (counted by " +
      "evidence type, direction and outcome, with the occupation and market pages they reach), older observations a newer source now also states, " +
      "observations whose review state changed, topics opened and topics with new claims (counted per answer), updates that happened since, and article " +
      "revisions written or approved since. Give occupation or market to see only what is new there (updates and articles are then left out). " +
      "Everything listed cannot have been in the earlier release; updates are a lower bound. When more observations are new than listed, `more` gives the " +
      "query_observations arguments that page through all of them. No key needed.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", minLength: 1, maxLength: 64, description: "A data release id (e.g. 20261102T081500Z-1a2b3c4d, from versions.data), a date YYYY-MM-DD (from its start, UTC) or a time with offset." },
        occupation: { type: "string", maxLength: 200, description: "Only what is new for this occupation: id, O*NET code, name in English or Chinese, or another name it is known by." },
        market: { type: "string", maxLength: 200, description: "Only what is new for this market: id, slug or name." },
        limit: { type: "integer", minimum: 1, maximum: MAX_OBSERVATIONS, default: DEFAULT_CHANGES, description: "How many items each list shows; totals count all." },
        language: LANGUAGE_SCHEMA,
      },
      required: ["since"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  KNOWLEDGE_SEARCH_TOOL,
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
    case "search_knowledge":
      return knowledgeAgent.search(args);
    case "search":
      return runSearch(args);
    case "get_record":
      return runRecord(args);
    case "query_observations":
      return runQueryObservations(args);
    case "occupation_summary":
      return runSummary(args);
    case "changes_since":
      return runChanges(args);
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
