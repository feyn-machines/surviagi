import type { Language } from "./i18n";
import { absoluteUrl } from "./seo";
import { termNameOrRaw, type VocabularyName } from "@/components/ontology-labels";
import {
  activityById,
  byStrength,
  dataRelease,
  EVIDENCE_ORDER,
  linkedEvents,
  manifest,
  markets,
  marketSlug,
  observationById,
  observationDate,
  observations,
  observationsOfMarket,
  observationsOfOccupation,
  observationsPublished,
  observationStats,
  occupations,
  occupationSlug,
  type EvidenceType,
  type ObservationRow,
} from "./snapshot";

/**
 * Observations for agents (Issue #29): one by id, a filtered list, and the counts of one occupation or market.
 * The counts are `observationStats` over the rows the market and occupation pages show (Issue #32), so an
 * agent quoting a number quotes the page's number. Everything is read from the loaded release in memory.
 */

export const OBSERVATION_ID = /^obs-[0-9a-f]{16}$/;

export const DIRECTIONS = ["ai_takes_on", "human_still_needed", "neutral"] as const;
export const OUTCOMES = ["succeeded", "partly", "failed", "not_stated"] as const;
export const REVIEW_STATES = ["machine_proposed", "human_confirmed", "human_rejected"] as const;
export const ORDERS = ["strength", "newest"] as const;

export const DEFAULT_OBSERVATIONS = 20;
export const MAX_OBSERVATIONS = 50;
/** How many representative ids, products or adopters a summary names. */
const TOP = 6;

export const OBSERVATION_CONTENT = {
  task: "Written by our pipeline from the source: what was done, not the source's own words.",
  quote: "Words copied from the source, possibly shortened. Every figure's quote contains the figure.",
  review_state: "machine_proposed until a person confirms or rejects the observation.",
} as const;

const NO_ORIGINAL = "The full text of the sources is not published here; open the source URLs.";

type Concept = { kind: "occupation" | "market"; id: string; slug: string; label_en: string; label_zh_cn: string | null };

function occupationConcepts(): Concept[] {
  return occupations().map((o) => ({
    kind: "occupation", id: o.occupation_id, slug: occupationSlug(o.occupation_id), label_en: o.label_en, label_zh_cn: o.label_zh_cn,
  }));
}

function marketConcepts(): Concept[] {
  return markets().map((m) => ({ kind: "market", id: m.id, slug: marketSlug(m.id), label_en: m.en, label_zh_cn: m.zh_cn }));
}

const fold = (text: string | null | undefined) => (text ?? "").normalize("NFKC").toLowerCase().trim();

export type Resolved = { ok: true; concept: Concept } | { ok: false; candidates: Concept[] };

/**
 * An occupation or market named by its id, the slug in its page address, or its name. A name matches whole
 * first, then as part of a name; more than one partial match is returned as candidates, never guessed.
 */
export function resolveConcept(kind: "occupation" | "market", given: string): Resolved {
  const all = kind === "occupation" ? occupationConcepts() : marketConcepts();
  const key = fold(given);
  const exact = all.find((c) => fold(c.id) === key || fold(c.slug) === key) ??
    all.find((c) => fold(c.label_en) === key || fold(c.label_zh_cn) === key);
  if (exact) return { ok: true, concept: exact };
  const partial = key.length >= 2 ? all.filter((c) => fold(c.label_en).includes(key) || fold(c.label_zh_cn).includes(key)) : [];
  if (partial.length === 1) return { ok: true, concept: partial[0] };
  return { ok: false, candidates: partial.slice(0, 10) };
}

export function candidateView(c: Concept, language: Language) {
  return { id: c.id, label: c.label_en, label_zh_cn: c.label_zh_cn, url: absoluteUrl(language, pagePath(c)) };
}

const pagePath = (c: Pick<Concept, "kind" | "slug">) => `/${c.kind === "occupation" ? "occupations" : "markets"}/${c.slug}`;

/** The pages that list an observation: each occupation it was mapped to, and each market of its work. */
function pagesOf(row: ObservationRow): Pick<Concept, "kind" | "slug" | "id">[] {
  const pages: Pick<Concept, "kind" | "slug" | "id">[] = [];
  for (const c of row.concerns) if (c.kind === "occupation") pages.push({ kind: "occupation", id: c.concept_id, slug: occupationSlug(c.concept_id) });
  const seen = new Set<string>();
  for (const c of row.concerns) {
    const market = c.kind === "work" ? activityById(c.concept_id)?.market_id : undefined;
    if (market && !seen.has(market)) {
      seen.add(market);
      pages.push({ kind: "market", id: market, slug: marketSlug(market) });
    }
  }
  return pages;
}

function observationUrls(row: ObservationRow, language: Language) {
  const page = pagesOf(row)[0];
  if (page) {
    return {
      url: absoluteUrl(language, `${pagePath(page)}#${row.observation_id}`),
      markdown_url: absoluteUrl(language, `${pagePath(page)}/raw.md`),
    };
  }
  return row.event_id && linkedEvents().some((e) => e.event_id === row.event_id)
    ? { url: absoluteUrl(language, `/updates/${row.event_id}`), markdown_url: absoluteUrl(language, `/updates/${row.event_id}/raw.md`) }
    : { url: null, markdown_url: null };
}

const term = (vocabulary: VocabularyName, value: string, language: Language) => termNameOrRaw(vocabulary, value, language);

/** One observation as a list shows it: enough to cite, with every figure and its words. */
export function observationSummary(row: ObservationRow, language: Language) {
  return {
    id: row.observation_id,
    type: "observation" as const,
    date: observationDate(row),
    evidence_type: row.evidence_type,
    evidence_type_label: term("event_basis", row.evidence_type, language),
    direction: row.direction,
    outcome: row.outcome,
    task: row.task,
    actor: { name: row.actor_name, role: row.actor_role, organization_id: row.actor_org_id },
    subject: row.subject_key === "unspecified" ? null : row.subject_key,
    facts: row.facts.map((f) => ({ value: f.value, unit: f.unit, what: f.what, quote: f.quote })),
    sources: row.sources.map((s) => ({ url: s.url, quote: s.quote, published_at: s.published_at })),
    review_state: row.review_state,
    ...observationUrls(row, language),
  };
}

/** One observation in full, as `get_record` returns it. `requested_id` differs from `id` when it was merged. */
export function observationRecord(requestedId: string, language: Language) {
  const row = observationById(requestedId);
  if (!row) return null;
  const update = row.event_id ? linkedEvents().find((e) => e.event_id === row.event_id) : undefined;
  return {
    ...observationSummary(row, language),
    ...(requestedId !== row.observation_id ? { merged_into: row.observation_id, requested_id: requestedId } : {}),
    content: OBSERVATION_CONTENT,
    actor: {
      key: row.actor_key, name: row.actor_name, role: row.actor_role,
      role_label: term("observation_actor_role", row.actor_role, language),
      organization_id: row.actor_org_id, person_id: row.actor_person_id,
    },
    subject: { key: row.subject_key, product_id: row.subject_product_id, model_id: row.subject_model_id },
    scale: row.scale,
    conditions: row.conditions,
    occurred_on: row.occurred_on,
    announced_at: row.announced_at,
    observed_at: row.observed_at,
    reviewed_at: row.reviewed_at,
    method: { extractor: row.extractor, model: row.model, prompt_sha256: row.prompt_sha256, schema_version: row.schema_version },
    facts: row.facts,
    sources: row.sources.map((s) => ({ url: s.url, source_type: s.source_type, quote: s.quote, published_at: s.published_at })),
    concerns: row.concerns.map((c) => ({ id: c.concept_id, kind: c.kind, label: c.label_en, label_zh_cn: c.label_zh_cn, method: c.method, status: c.status })),
    pages: pagesOf(row).map((p) => ({ kind: p.kind, id: p.id, url: absoluteUrl(language, `${pagePath(p)}#${row.observation_id}`) })),
    update: update ? { id: update.event_id, title: update.title, url: absoluteUrl(language, `/updates/${update.event_id}`) } : null,
    merged_from: row.merged_from,
    original_text: { available: false, note: NO_ORIGINAL },
  };
}

export type ObservationFilter = {
  occupation?: Concept;
  market?: Concept;
  task?: string;
  organization?: string;
  subject?: string;
  evidenceTypes?: EvidenceType[];
  directions?: (typeof DIRECTIONS)[number][];
  outcomes?: (typeof OUTCOMES)[number][];
  reviewStates?: (typeof REVIEW_STATES)[number][];
  from?: string | null;
  to?: string | null;
};

/** The rows a filter selects. Occupation and market select exactly the rows their pages list. */
export function filterObservations(filter: ObservationFilter): ObservationRow[] {
  let rows = filter.occupation ? observationsOfOccupation(filter.occupation.id)
    : filter.market ? observationsOfMarket(filter.market.id)
    : observations();
  if (filter.occupation && filter.market) {
    const inMarket = new Set(observationsOfMarket(filter.market.id));
    rows = rows.filter((r) => inMarket.has(r));
  }
  const organization = fold(filter.organization);
  const subject = fold(filter.subject);
  return rows.filter((r) => {
    if (filter.task && !r.concerns.some((c) => c.concept_id === filter.task)) return false;
    if (organization && ![r.actor_org_id, r.actor_key, r.actor_name].some((v) => fold(v) === organization)) return false;
    if (subject && ![r.subject_key, r.subject_product_id, r.subject_model_id].some((v) => fold(v) === subject)) return false;
    if (filter.evidenceTypes?.length && !filter.evidenceTypes.includes(r.evidence_type)) return false;
    if (filter.directions?.length && !filter.directions.includes(r.direction)) return false;
    if (filter.outcomes?.length && !filter.outcomes.includes(r.outcome)) return false;
    if (filter.reviewStates?.length && !filter.reviewStates.includes(r.review_state)) return false;
    const day = observationDate(r);
    if (filter.from && (!day || day < filter.from)) return false;
    if (filter.to && (!day || day > filter.to)) return false;
    return true;
  });
}

const byNewest = (a: ObservationRow, b: ObservationRow) =>
  (observationDate(b) ?? "").localeCompare(observationDate(a) ?? "") || a.observation_id.localeCompare(b.observation_id);

export function sortObservations(rows: ObservationRow[], order: (typeof ORDERS)[number]): ObservationRow[] {
  return [...rows].sort(order === "newest" ? byNewest : byStrength);
}

/** The day counts are taken as of: the release's, as on the pages. */
export const statsDate = (): string | null => manifest()?.generated_at ?? null;

function tally<T extends string>(values: T[]): Record<T, number> {
  const out = {} as Record<T, number>;
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/** Counts as the pages state them, plus the splits a page shows only as lists. */
export function observationCounts(rows: ObservationRow[]) {
  const stats = observationStats(rows, statsDate());
  return {
    as_of: statsDate()?.slice(0, 10) ?? null,
    total: stats.total,
    by_evidence_type: Object.fromEntries(EVIDENCE_ORDER.map((t) => [t, stats.byType[t]])) as Record<EvidenceType, number>,
    by_direction: { ...Object.fromEntries(DIRECTIONS.map((d) => [d, 0])), ...tally(rows.map((r) => r.direction)) },
    by_outcome: { ...Object.fromEntries(OUTCOMES.map((o) => [o, 0])), ...tally(rows.map((r) => r.outcome)) },
    against: stats.against,
    last_30_days: stats.last30,
    last_90_days: stats.last90,
    undated: stats.undated,
  };
}

/** The most frequent values among rows, each with how many rows carry it. */
function top<T>(rows: ObservationRow[], key: (r: ObservationRow) => string | null, view: (r: ObservationRow) => T) {
  const counts = new Map<string, { n: number; row: ObservationRow }>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const seen = counts.get(k);
    if (seen) seen.n += 1;
    else counts.set(k, { n: 1, row: r });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, TOP)
    .map(([k, { n, row }]) => ({ key: k, observations: n, ...view(row) }));
}

/** What `occupation_summary` returns for one occupation or market. */
export function conceptSummary(concept: Concept, language: Language) {
  const page = { url: absoluteUrl(language, pagePath(concept)), markdown_url: absoluteUrl(language, `${pagePath(concept)}/raw.md`) };
  const head = { kind: concept.kind, id: concept.id, label: concept.label_en, label_zh_cn: concept.label_zh_cn, ...page };
  if (!observationsPublished()) {
    return { ...head, state: "unpublished" as const, counts: null, note: "This data release does not carry observations yet: the counts are unknown, not zero." };
  }
  const rows = concept.kind === "occupation" ? observationsOfOccupation(concept.id) : observationsOfMarket(concept.id);
  const sorted = [...rows].sort(byStrength);
  const otherWay = sorted.filter((r) => r.direction === "human_still_needed");
  const forward = sorted.filter((r) => r.direction !== "human_still_needed");
  return {
    ...head,
    state: rows.length ? ("some" as const) : ("none" as const),
    counts: observationCounts(rows),
    strongest: forward.slice(0, TOP).map((r) => observationSummary(r, language)),
    other_way: otherWay.slice(0, TOP).map((r) => observationSummary(r, language)),
    tasks: concept.kind === "occupation" ? taskCounts(rows) : null,
    products: top(rows, (r) => (r.subject_key === "unspecified" ? null : r.subject_key), (r) => ({ product_id: r.subject_product_id, model_id: r.subject_model_id })),
    adopters: top(rows.filter((r) => r.actor_role === "adopter"), (r) => r.actor_key, (r) => ({ name: r.actor_name, organization_id: r.actor_org_id })),
    external_indices: null,
    note: rows.length
      ? "Counts are of observations read by a model from collected posts, as of the release date; the page shows the same numbers. They describe what was collected, not the work itself. external_indices is null: no index reading is collected yet."
      : "No observation has been mapped here yet. That describes what was collected and read, not the work itself.",
  };
}

/** The tasks of an occupation its observations were mapped to, most observed first. */
function taskCounts(rows: ObservationRow[]) {
  const counts = new Map<string, { n: number; label: string | null; label_zh_cn: string | null }>();
  for (const r of rows) {
    for (const c of new Map(r.concerns.filter((c) => c.kind === "task").map((c) => [c.concept_id, c])).values()) {
      const seen = counts.get(c.concept_id) ?? { n: 0, label: c.label_en, label_zh_cn: c.label_zh_cn };
      seen.n += 1;
      counts.set(c.concept_id, seen);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([id, v]) => ({ id, label: v.label, label_zh_cn: v.label_zh_cn, observations: v.n }));
}

/** A cursor is the release it was handed out for and the offset of the next row. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ r: dataRelease().releaseId, l: dataRelease().loadedAt, o: offset })).toString("base64url");
}

export function decodeCursor(cursor: string): { ok: true; offset: number } | { ok: false; stale: boolean } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { r?: unknown; l?: unknown; o?: unknown };
    if (typeof value.o !== "number" || !Number.isInteger(value.o) || value.o < 0) return { ok: false, stale: false };
    if (value.r !== dataRelease().releaseId || value.l !== dataRelease().loadedAt) return { ok: false, stale: true };
    return { ok: true, offset: value.o };
  } catch {
    return { ok: false, stale: false };
  }
}
