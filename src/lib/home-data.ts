import { updateTimestamp } from "./update-date";
import { vocabularyTerm } from "@/components/ontology-labels";
import marketGroups from "@/content/market-groups.json";
import * as snapshot from "@/lib/snapshot";

/**
 * Everything the homepage draws, in one compact object the server builds once
 * and hands to the client modules. Every module reads this and nothing else, so
 * a module can be changed or replaced without touching the others.
 *
 * Only work that some update bears on is here: the catalogue total is a number
 * for the text, never a shape on the page.
 */
export type Both = { en: string; zh: string };

export type HomeWork = {
  id: string;
  name: Both;
  market: Both;
  marketId: string;
  /** The ontology `market_group` this work's market belongs to. */
  domainId: string;
  /** Accepted level, 1-5. Work with no accepted evidence is not in the list. */
  level: number;
};

export type HomeUpdate = {
  id: string;
  title: string;
  summary: string;
  org: string;
  /** Days since the window opened; undated updates carry `date: null`. */
  day: number;
  date: string | null;
  /** True when the timeline uses the source announcement instead of an occurrence. */
  announced: boolean;
  url: string | null;
  sources: number;
  kind: Both | null;
  /** The `event_kind` vocabulary id, e.g. `production_adoption`. */
  kindId: string | null;
  /** Views of the source posts at snapshot time; null when not collected. */
  views: number | null;
  likes: number | null;
};

/** One update bearing on one kind of work. */
export type HomeRow = {
  update: string;
  work: string;
  claimed: number;
  accepted: number;
  /** T3 publisher only, T2 several sources, T1 independent. */
  tier: string;
};

/** The home page counts the updates of the last this many days of the window. */
export const RECENT_DAYS = 30;

export type HomeData = {
  start: string;
  days: number;
  /** Dated updates in the last `RECENT_DAYS` days of the window; undated ones are not counted. */
  recentUpdates: number;
  generatedAt: string;
  orgsTracked: number;
  catalogueWorks: number;
  catalogueDomains: number;
  domains: Record<string, Both>;
  works: HomeWork[];
  updates: HomeUpdate[];
  rows: HomeRow[];
};

/**
 * The market groups of the current sealed ontology release and which group each
 * market sits in. `pnpm ontology:projections` generates the file, because the
 * release itself stays out of the server's files; `pnpm ontology:check` fails
 * when it is stale. A market with no group is not drawn on the homepage.
 */
const GROUPS = marketGroups as { groups: Record<string, Both>; group_of_market: Record<string, string> };

const DAY = 24 * 60 * 60 * 1000;
const dayOf = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/**
 * Null when there is no snapshot, or the snapshot has no dated window: the page
 * then says so instead of drawing an empty figure.
 */
export function buildHomeData(): HomeData | null {
  const manifest = snapshot.manifest();
  const coverage = snapshot.coverage();
  const times = snapshot.chainEvents().map(updateTimestamp).filter((at): at is string => Boolean(at));
  const first = [coverage?.collection_window.first, ...times].filter((at): at is string => Boolean(at)).sort()[0];
  const last = [coverage?.collection_window.last, ...times].filter((at): at is string => Boolean(at)).sort().at(-1);
  if (!manifest || !coverage || !first || !last) return null;

  // Domains are sealed ontology concepts, not a prefix cut from a market id.
  const groups = new Map(Object.entries(GROUPS.groups));
  const groupOfMarket = new Map(Object.entries(GROUPS.group_of_market));

  const works: HomeWork[] = [];
  const domains: Record<string, Both> = {};
  for (const a of snapshot.activities()) {
    const domainId = groupOfMarket.get(a.market_id);
    if (!a.evidence_rows || !a.level || !domainId) continue;
    const domain = groups.get(domainId);
    if (!domain) continue;
    domains[domainId] = domain;
    works.push({
      id: a.activity_id,
      name: { en: a.label_en, zh: a.label_zh_cn ?? a.label_en },
      market: { en: a.market_en, zh: a.market_zh_cn ?? a.market_en },
      marketId: a.market_id,
      domainId,
      level: Math.round(a.level),
    });
  }
  const known = new Set(works.map((w) => w.id));

  const rows: HomeRow[] = [];
  const used = new Set<string>();
  for (const r of snapshot.evidence()) {
    if (r.level == null || r.observed_level == null || !known.has(r.activity_id)) continue;
    used.add(r.event_id);
    rows.push({ update: r.event_id, work: r.activity_id, claimed: r.observed_level, accepted: r.level, tier: r.evidence_tier });
  }

  const start = dayOf(first);
  const days = Math.round((dayOf(last) - start) / DAY) + 1;
  const detail = new Map(snapshot.events().map((e) => [e.event_id, e]));
  const updates: HomeUpdate[] = [];
  for (const e of snapshot.chainEvents()) {
    if (!used.has(e.event_id)) continue;
    const more = detail.get(e.event_id);
    const term = vocabularyTerm("event_kind", more?.kind);
    const date = updateTimestamp(e)?.slice(0, 10) ?? null;
    const day = date ? Math.min(days - 1, Math.max(0, Math.round((dayOf(date) - start) / DAY))) : days - 1;
    updates.push({
      id: e.event_id,
      title: e.title,
      summary: e.summary,
      org: e.org_name ?? "",
      day,
      date,
      announced: !e.occurred_at && Boolean(e.announced_at),
      url: e.source_urls[0] ?? null,
      sources: e.source_urls.length,
      kind: term?.en ? { en: term.en, zh: term["zh-CN"] ?? term.en } : null,
      kindId: more?.kind ?? null,
      views: more?.attention?.views ?? null,
      likes: more?.attention?.likes ?? null,
    });
  }

  return {
    start: first.slice(0, 10),
    days,
    recentUpdates: updates.filter((u) => u.date !== null && u.day >= days - RECENT_DAYS).length,
    generatedAt: manifest.generated_at.slice(0, 10),
    orgsTracked: coverage.events_by_organisation.length,
    catalogueWorks: coverage.activities_total,
    catalogueDomains: groups.size,
    domains,
    works,
    updates,
    rows,
  };
}
