import { updateTimestamp } from "./update-date";
import {
  activities,
  linkedEvents,
  links,
  groupSlug,
  marketEdges,
  markets,
  marketSlug,
  occupationSlug,
  occupationGroups,
  occupations,
  topics,
  updateCountByMarket,
  type EventRow,
  type OccupationGroup,
  type Topic,
} from "./snapshot";

/** Pages that exist whatever the snapshot holds. */
export const FIXED_PATHS = ["/", "/markets", "/occupations", "/topics", "/updates", "/voices", "/articles", "/whitepaper", "/agents", "/privacy", "/terms"] as const;

/**
 * Which detail pages are offered to search engines (Issue #36, design 2026-11-02 §8.6). A page that misses its
 * threshold still answers, but asks not to be indexed and stays out of the sitemap: a search engine judges a site by
 * its pages, and hundreds of near-identical short ones made it set most of them aside.
 *
 * Until observations are published (#25), "has evidence" for a market or an occupation means an update bears on it.
 * Every catalog label has its Chinese form, so a Chinese page is offered beside its English one; an update keeps its
 * original words and is offered once (`UPDATE_LANGUAGES`).
 */
export const indexable = {
  /** It states a figure, says what was done and how it came out, or more than one source carries it. */
  update: (e: Pick<EventRow, "facts" | "task" | "result" | "source_count">) =>
    (e.facts?.length ?? 0) > 0 || Boolean(e.task && e.result && e.result !== "not_stated") || e.source_count >= 2,
  /** At least two accounts argue it, so it is a question people disagree on rather than one post. */
  topic: (t: Pick<Topic, "accounts">) => t.accounts >= 2,
  market: (marketId: string) => (updateCountByMarket().get(marketId) ?? 0) > 0,
  occupation: (touchedTasks: number) => touchedTasks > 0,
  group: (g: Pick<OccupationGroup, "touched_tasks">) => g.touched_tasks > 0,
};

/**
 * The detail pages of the loaded data release that meet `indexable`: what the sitemap names. Each detail route
 * looks its entity up in the same release and answers 404 when it is absent, so the sitemap cannot name a page that
 * does not exist.
 */
export const indexedPages = {
  markets: () => markets().filter((market) => indexable.market(market.id)).map((market) => marketSlug(market.id)),
  occupations: () => occupations().filter((row) => indexable.occupation(row.touched)).map((row) => occupationSlug(row.occupation_id)),
  occupationGroups: () => occupationGroups().filter(indexable.group).map((group) => groupSlug(group.id)),
  topics: () => topics().filter(indexable.topic).map((topic) => ({ slug: topic.slug, latest: topic.latest_claim_at })),
  updates: () => linkedEvents().filter(indexable.update).map((e) => ({ id: e.event_id, occurredAt: updateTimestamp(e) })),
};

/** An update keeps its original words in every language, so it is listed once. */
export const UPDATE_LANGUAGES = ["en"] as const;

/**
 * When each detail page last had something new to show: the newest occurrence or source announcement among the updates whose
 * readings it lists, following the same joins as the pages (work -> its readings; market -> its work;
 * occupation -> the markets serving it; group -> its occupations). Undefined when none of its readings is dated.
 * A page's sitemap `lastmod` is this rather than the time the data was published, so it moves only when the
 * page does: a search engine trusts a `lastmod` that is accurate, and a diff of two sitemaps names the pages
 * that changed.
 */
export function evidenceDates() {
  const occurred = new Map(linkedEvents().map((e) => [e.event_id, updateTimestamp(e)]));
  const newer = (a: string | null | undefined, b: string | null | undefined) =>
    !a ? b ?? null : !b || Date.parse(a) > Date.parse(b) ? a : b;
  const work = new Map<string, string | null>();
  for (const row of links()) work.set(row.activity_id, newer(work.get(row.activity_id), occurred.get(row.event_id)));
  const market = new Map<string, string | null>();
  for (const a of activities()) market.set(a.market_id, newer(market.get(a.market_id), work.get(a.activity_id)));
  const occupation = new Map<string, string | null>();
  for (const edge of marketEdges()) {
    occupation.set(edge.occupation_id, newer(occupation.get(edge.occupation_id), market.get(edge.market_id)));
  }
  const group = new Map<string, string | null>();
  for (const row of occupations()) {
    if (row.group_id) group.set(row.group_id, newer(group.get(row.group_id), occupation.get(row.occupation_id)));
  }
  const at = (dates: Map<string, string | null>) => (id: string) => dates.get(id) ?? undefined;
  return { work: at(work), market: at(market), occupation: at(occupation), group: at(group) };
}
