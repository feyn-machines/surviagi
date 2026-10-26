import {
  activities,
  chainEvents,
  evidence,
  groupSlug,
  marketEdges,
  markets,
  marketSlug,
  occupationSlug,
  occupations,
  progress,
  topics,
} from "./snapshot";
import { workSlug } from "./routes";

/** Pages that exist whatever the snapshot holds. */
export const FIXED_PATHS = ["/", "/markets", "/occupations", "/topics", "/updates", "/voices", "/articles", "/whitepaper", "/agents", "/privacy", "/terms"] as const;

/**
 * The detail pages of the loaded data release. Each detail route looks its
 * entity up in the same release and answers 404 when it is absent, and the
 * sitemap lists exactly this list, so the sitemap cannot name a page that does
 * not exist.
 */
export const detailPages = {
  markets: () => markets().map((market) => marketSlug(market.id)),
  occupations: () => occupations().map((row) => occupationSlug(row.occupation_id)),
  /** Occupations an update has reached: the ones a search engine is told about. */
  reachedOccupations: () => occupations().filter((row) => row.assessed > 0).map((row) => occupationSlug(row.occupation_id)),
  occupationGroups: () => Object.keys(progress()?.groups ?? {}).map(groupSlug),
  /** Only work an update has reached has a page of its own. */
  work: () => activities().filter((a) => a.evidence_rows && a.level).map((a) => workSlug(a.activity_id)),
  topics: () => topics().map((topic) => ({ slug: topic.slug, latest: topic.latest_claim_at })),
  updates: () => chainEvents().map((e) => ({ id: e.event_id, occurredAt: e.occurred_at ?? null })),
};

/** An update keeps its original words in every language, so it is listed once. */
export const UPDATE_LANGUAGES = ["en"] as const;

/**
 * When each detail page last had something new to show: the newest `occurred_at` among the updates whose
 * readings it lists, following the same joins as the pages (work -> its readings; market -> its work;
 * occupation -> the markets serving it; group -> its occupations). Undefined when none of its readings is dated.
 * A page's sitemap `lastmod` is this rather than the time the data was published, so it moves only when the
 * page does: a search engine trusts a `lastmod` that is accurate, and a diff of two sitemaps names the pages
 * that changed.
 */
export function evidenceDates() {
  const occurred = new Map(chainEvents().map((e) => [e.event_id, e.occurred_at ?? null]));
  const newer = (a: string | null | undefined, b: string | null | undefined) =>
    !a ? b ?? null : !b || Date.parse(a) > Date.parse(b) ? a : b;
  const work = new Map<string, string | null>();
  for (const row of evidence()) work.set(row.activity_id, newer(work.get(row.activity_id), occurred.get(row.event_id)));
  const market = new Map<string, string | null>();
  for (const a of activities()) market.set(a.market_id, newer(market.get(a.market_id), work.get(a.activity_id)));
  const occupation = new Map<string, string | null>();
  for (const edge of marketEdges()) {
    occupation.set(edge.occupation_id, newer(occupation.get(edge.occupation_id), market.get(edge.market_id)));
  }
  const group = new Map<string, string | null>();
  for (const [id, entry] of Object.entries(progress()?.occupations ?? {})) {
    if (entry.group_id) group.set(entry.group_id, newer(group.get(entry.group_id), occupation.get(id)));
  }
  const at = (dates: Map<string, string | null>) => (id: string) => dates.get(id) ?? undefined;
  return { work: at(work), market: at(market), occupation: at(occupation), group: at(group) };
}
