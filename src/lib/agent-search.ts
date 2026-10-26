import type { Language } from "./i18n";
import { absoluteUrl } from "./seo";
import { workSlug } from "./routes";
import {
  activityById,
  chainEvents,
  dataRelease,
  events,
  evidence,
  manifest,
  topics,
  type ChainEvent,
  type EventRow,
  type EvidenceRow,
  type Topic,
} from "./snapshot";

/**
 * Search and record reading for agents (Issue #5). Everything here is read from the data release the pages
 * render, in memory: the same updates, topics and readings a reader can open on the site, and nothing else.
 * No collection store, no raw archive, no reader's submission, no model is reached from here, and a query
 * that finds nothing starts nothing.
 */

export const RECORD_TYPES = ["update", "question", "evidence"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const MAX_QUERY = 200;
export const MAX_RESULTS = 20;
export const DEFAULT_RESULTS = 8;
const SNIPPET = 280;
const DETAIL_ROWS = 30;

/** What a text is, so a caller never quotes our summary as the source's words. */
export const CONTENT_KINDS = {
  machine_summary: "Written by our pipeline from the source posts; not the source's own words.",
  post_quote: "Words copied from the original post, possibly shortened.",
  machine_reading: "A level proposed by our judge for one kind of work; not reviewed by a person.",
} as const;

const REVIEW = "machine_proposed_unreviewed";

/** The original text of X posts is not in the published data: only their addresses are, and short quotes on topics. */
const ORIGINAL_GAP =
  "The full text of the source posts is not published here. Open the source URLs for the original; X Articles, linked pages and PDFs are not collected.";

export function releaseInfo() {
  const m = manifest();
  return { id: dataRelease().releaseId, generated_at: m?.generated_at ?? null, method: m?.method_version ?? null };
}

type Doc = {
  id: string;
  type: RecordType;
  title: string;
  snippet: string;
  content: keyof typeof CONTENT_KINDS;
  date: string | null;
  organization: string | null;
  sources: string[];
  path: string;
  /** Lower-cased fields with weights, searched by substring. */
  fields: { text: string; weight: number }[];
};

const lower = (text: string | null | undefined) => (text ?? "").normalize("NFKC").toLowerCase();
const clip = (text: string, max = SNIPPET) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join("")}…` : flat;
};

export const evidenceId = (row: Pick<EvidenceRow, "event_id" | "activity_id">) =>
  `evidence:${row.event_id}:${workSlug(row.activity_id)}`;

/** Only work an update has given a level has a page of its own; the same rule as the work page and the sitemap. */
function workHasPage(activityId: string) {
  const work = activityById(activityId);
  return Boolean(work?.evidence_rows && work.level);
}

function buildDocs(): Doc[] {
  const rows = new Map<string, EventRow>(events().map((e) => [e.event_id, e]));
  const docs: Doc[] = [];
  const updates = new Map<string, ChainEvent>();
  for (const e of chainEvents()) {
    updates.set(e.event_id, e);
    const more = rows.get(e.event_id);
    docs.push({
      id: e.event_id,
      type: "update",
      title: e.title,
      snippet: clip(e.summary || e.title),
      content: "machine_summary",
      date: e.occurred_at ?? more?.occurred_at ?? null,
      organization: e.org_name,
      sources: e.source_urls ?? [],
      path: `/updates/${e.event_id}`,
      fields: [
        { text: lower(e.title), weight: 3 },
        { text: lower(e.summary), weight: 1 },
        { text: lower([e.org_name, more?.org_name_zh_cn, more?.kind].filter(Boolean).join(" ")), weight: 2 },
      ],
    });
  }
  for (const t of topics()) {
    docs.push({
      id: t.topic_id,
      type: "question",
      title: t.question.en,
      snippet: clip(`${t.question["zh-CN"]} · ${t.options.map((o) => `${o.key}) ${o.text.en}`).join(" ")}`),
      content: "machine_summary",
      date: t.latest_claim_at ?? t.opened_at,
      organization: null,
      sources: [],
      path: `/topics/${t.slug}`,
      fields: [
        { text: lower(`${t.question.en} ${t.question["zh-CN"]} ${t.object}`), weight: 3 },
        { text: lower([t.about?.en, t.about?.["zh-CN"], t.group?.en, t.group?.["zh-CN"]].filter(Boolean).join(" ")), weight: 2 },
        { text: lower(t.options.map((o) => `${o.text.en} ${o.text["zh-CN"]}`).join(" ")), weight: 1 },
      ],
    });
  }
  for (const r of evidence()) {
    const update = updates.get(r.event_id);
    const work = activityById(r.activity_id);
    if (!update || !work) continue;
    docs.push({
      id: evidenceId(r),
      type: "evidence",
      title: `${work.label_en} ← ${update.title}`,
      snippet: clip(`L${r.level ?? "?"} (${r.evidence_tier}) · ${work.market_en} · ${update.summary || update.title}`),
      content: "machine_reading",
      date: update.occurred_at,
      organization: update.org_name,
      sources: update.source_urls ?? [],
      path: workHasPage(r.activity_id) ? `/work/${workSlug(r.activity_id)}` : `/updates/${r.event_id}`,
      fields: [
        { text: lower(`${work.label_en} ${work.label_zh_cn ?? ""}`), weight: 3 },
        { text: lower(`${work.market_en} ${work.market_zh_cn ?? ""} ${update.title}`), weight: 2 },
        { text: lower(update.org_name), weight: 1 },
      ],
    });
  }
  return docs;
}

let cached: { key: string; docs: Doc[] } | null = null;

/** The documents of the loaded release, built once per release. */
function docs(): Doc[] {
  const release = dataRelease();
  const key = `${release.releaseId}|${release.loadedAt}`;
  if (cached?.key !== key) cached = { key, docs: buildDocs() };
  return cached.docs;
}

const STOP = new Set(["a", "an", "and", "the", "of", "to", "in", "on", "for", "is", "are", "be", "by", "with", "or", "at", "as", "it", "its", "do", "does", "will", "what", "how", "which", "who"]);

/** Latin words and numbers whole; Chinese, Japanese and Korean runs as overlapping pairs (one character alone stays one). */
export function terms(query: string): string[] {
  const out = new Set<string>();
  for (const word of lower(query).match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? []) {
    for (const part of word.split(/(\p{Script=Han}+|\p{Script=Hiragana}+|\p{Script=Katakana}+|\p{Script=Hangul}+)/u)) {
      if (!part) continue;
      if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(part)) {
        const chars = [...part];
        if (chars.length === 1) out.add(part);
        for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
      } else {
        const clean = part.replace(/[.+#-]+$/, "");
        if (clean && !STOP.has(clean)) out.add(clean);
      }
    }
  }
  return [...out].slice(0, 24);
}

export type SearchInput = {
  query: string;
  limit?: number;
  types?: RecordType[];
  from?: string | null;
  to?: string | null;
  language?: Language;
};

export type SearchResult = {
  id: string;
  type: RecordType;
  title: string;
  snippet: string;
  content: keyof typeof CONTENT_KINDS;
  review: typeof REVIEW;
  date: string | null;
  organization: string | null;
  url: string;
  markdown_url: string;
  sources: string[];
};

/**
 * Ranks the release's records by how many query terms they contain, weighted by field, with a bonus for the
 * whole query as typed; at least half the terms must match. Ties go to the newer record. Dates filter on the
 * record's own date (an update's `occurred_at`, a question's latest claim), and an undated record passes no
 * date filter. A query of one or two terms needs all of them: "coding agent" is not every record about agents.
 */
export function search(input: SearchInput) {
  const words = terms(input.query);
  const phrase = lower(input.query).trim();
  const limit = Math.min(MAX_RESULTS, Math.max(1, input.limit ?? DEFAULT_RESULTS));
  const types = new Set(input.types?.length ? input.types : RECORD_TYPES);
  const language = input.language ?? "en";
  const need = words.length <= 2 ? words.length : Math.ceil(words.length / 2);
  const scored: { doc: Doc; score: number }[] = [];
  for (const doc of words.length === 0 ? [] : docs()) {
    if (!types.has(doc.type)) continue;
    if (input.from && (!doc.date || doc.date.slice(0, 10) < input.from)) continue;
    if (input.to && (!doc.date || doc.date.slice(0, 10) > input.to)) continue;
    let matched = 0;
    let score = 0;
    for (const word of words) {
      let best = 0;
      for (const field of doc.fields) if (field.weight > best && field.text.includes(word)) best = field.weight;
      if (best > 0) {
        matched += 1;
        score += best;
      }
    }
    if (matched < need) continue;
    if (phrase.length > 2 && doc.fields.some((field) => field.text.includes(phrase))) score += 5;
    scored.push({ doc, score: score + matched / Math.max(1, words.length) });
  }
  scored.sort((a, b) => b.score - a.score || (b.doc.date ?? "").localeCompare(a.doc.date ?? "") || a.doc.id.localeCompare(b.doc.id));
  return {
    query: input.query,
    total: scored.length,
    results: scored.slice(0, limit).map(({ doc }): SearchResult => ({
      id: doc.id,
      type: doc.type,
      title: doc.title,
      snippet: doc.snippet,
      content: doc.content,
      review: REVIEW,
      date: doc.date,
      organization: doc.organization,
      url: absoluteUrl(language, doc.path),
      markdown_url: absoluteUrl(language, `${doc.path}/raw.md`),
      sources: doc.sources,
    })),
    release: releaseInfo(),
    content_kinds: CONTENT_KINDS,
  };
}

const ID_UPDATE = /^ev-[0-9a-f]{40}$/;
const ID_EVIDENCE = /^evidence:(ev-[0-9a-f]{40}):([a-z0-9-]{1,200})$/;
const ID_QUESTION = /^topic:[a-z_]+:[a-z0-9-]*:[0-9a-f]{8}$/;

/** True for the shape of an id `search` hands out; says nothing about whether the release holds it. */
export function isRecordId(id: string): boolean {
  return ID_UPDATE.test(id) || ID_EVIDENCE.test(id) || ID_QUESTION.test(id);
}

function updateRecord(e: ChainEvent, language: Language) {
  const more = events().find((row) => row.event_id === e.event_id);
  const readings = evidence().filter((r) => r.event_id === e.event_id);
  return {
    id: e.event_id,
    type: "update" as const,
    url: absoluteUrl(language, `/updates/${e.event_id}`),
    markdown_url: absoluteUrl(language, `/updates/${e.event_id}/raw.md`),
    title: e.title,
    summary: e.summary,
    summary_content: "machine_summary" as const,
    review: REVIEW,
    kind: more?.kind ?? null,
    organization: e.org_name,
    organization_zh_cn: more?.org_name_zh_cn ?? null,
    occurred_at: e.occurred_at ?? more?.occurred_at ?? null,
    sources: (e.source_urls ?? []).map((url) => ({ url, kind: "original_post" as const })),
    original_text: { available: false, note: ORIGINAL_GAP },
    readings_total: readings.length,
    readings: readings.slice(0, DETAIL_ROWS).map((r) => readingSummary(r, language)),
  };
}

function readingSummary(r: EvidenceRow, language: Language) {
  const work = activityById(r.activity_id);
  return {
    id: evidenceId(r),
    work: work ? { label: work.label_en, label_zh_cn: work.label_zh_cn, market: work.market_en } : null,
    work_url: workHasPage(r.activity_id) ? absoluteUrl(language, `/work/${workSlug(r.activity_id)}`) : null,
    level: r.level,
    claimed_level: r.observed_level,
    evidence_tier: r.evidence_tier,
    status: r.status,
  };
}

function questionRecord(t: Topic, language: Language) {
  return {
    id: t.topic_id,
    type: "question" as const,
    url: absoluteUrl(language, `/topics/${t.slug}`),
    markdown_url: absoluteUrl(language, `/topics/${t.slug}/raw.md`),
    question: t.question,
    about: t.about,
    state: t.state,
    origin: t.origin,
    opened_at: t.opened_at,
    latest_claim_at: t.latest_claim_at,
    note: "A question carries no answer of its own: options list who argued them in the posts collected, not who is right.",
    review: REVIEW,
    options: t.options.map((o) => ({ key: o.key, text: o.text, accounts: o.accounts, supports: o.supports, contradicts: o.contradicts })),
    claims_total: t.claims.length,
    claims: t.claims.slice(0, DETAIL_ROWS).map((c) => ({
      option: c.option,
      handle: c.handle,
      url: c.url,
      published_at: c.published_at,
      says: c.says,
      says_content: "machine_summary" as const,
      quote: c.quote,
      quote_content: c.quote ? ("post_quote" as const) : null,
    })),
    evidence_total: t.evidence.length,
    evidence: t.evidence.slice(0, DETAIL_ROWS).map((v) => ({
      update_id: v.event_id,
      option: v.option,
      sign: v.sign,
      confidence: v.confidence,
      title: v.title,
      occurred_at: v.occurred_at,
      source_url: v.source_url,
    })),
    original_text: { available: false, note: ORIGINAL_GAP },
  };
}

function evidenceRecord(r: EvidenceRow, e: ChainEvent, language: Language) {
  const work = activityById(r.activity_id);
  const workUrl = workHasPage(r.activity_id) ? absoluteUrl(language, `/work/${workSlug(r.activity_id)}`) : null;
  return {
    id: evidenceId(r),
    type: "evidence" as const,
    /** The page that shows this reading: its work's page, or the update's when the work has none. */
    url: workUrl ?? absoluteUrl(language, `/updates/${e.event_id}`),
    content: "machine_reading" as const,
    review: REVIEW,
    status: r.status,
    work: work ? { label: work.label_en, label_zh_cn: work.label_zh_cn, market: work.market_en, market_zh_cn: work.market_zh_cn } : null,
    work_url: workUrl,
    level: r.level,
    claimed_level: r.observed_level,
    level_note: "`level` is what the evidence tier allows; `claimed_level` is what the judge proposed before that cap.",
    evidence_tier: r.evidence_tier,
    confidence: r.confidence,
    rationale: r.rationale,
    update: { id: e.event_id, title: e.title, url: absoluteUrl(language, `/updates/${e.event_id}`), occurred_at: e.occurred_at, organization: e.org_name },
    sources: (e.source_urls ?? []).map((url) => ({ url, kind: "original_post" as const })),
    confirmations: (r.confirmations ?? []).slice(0, DETAIL_ROWS).map((c) => ({
      handle: c.handle, url: c.url, posted_at: c.posted_at, post_nature: c.post_nature, evidence_tier: c.evidence_tier, level: c.level,
    })),
    original_text: { available: false, note: ORIGINAL_GAP },
  };
}

/** One record of the loaded release by the id `search` gave, or null when the release does not hold it. */
export function record(id: string, language: Language = "en") {
  const release = releaseInfo();
  if (ID_UPDATE.test(id)) {
    const e = chainEvents().find((row) => row.event_id === id);
    return e ? { ...updateRecord(e, language), release } : null;
  }
  if (ID_QUESTION.test(id)) {
    const t = topics().find((row) => row.topic_id === id);
    return t ? { ...questionRecord(t, language), release } : null;
  }
  const parts = ID_EVIDENCE.exec(id);
  if (parts) {
    const e = chainEvents().find((row) => row.event_id === parts[1]);
    const r = evidence().find((row) => row.event_id === parts[1] && workSlug(row.activity_id) === parts[2]);
    return e && r ? { ...evidenceRecord(r, e, language), release } : null;
  }
  return null;
}

/** The published topic whose question is this one, folded the same way submissions are compared. */
export function publishedQuestion(fold: (text: string) => string, question: string): Topic | undefined {
  const key = fold(question);
  return topics().find((t) => fold(t.question.en) === key || fold(t.question["zh-CN"]) === key);
}
