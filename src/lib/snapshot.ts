import { updateTimestamp } from "./update-date";
import { activityAnchor } from "./anchors";

// Re-exported so pages keep one import for everything about the snapshot,
// while client components take it straight from ./anchors and stay free of
// the data store this module holds.
export { activityAnchor };

// The website renders from one data release held in memory. The release comes from
// the server database (`DATABASE_URL`) or, in development and tests, from the
// published snapshot files; see `snapshot-source.ts` and `instrumentation.ts`. A
// page render never opens a connection and never starts a collection run.

export type Bilingual = { en: string; "zh-CN": string };

export type Manifest = {
  snapshot_version: string;
  generated_at: string;
  ontology_version: string;
  schema_version: string;
  method_version: string;
  counts: Record<string, number>;
  content_sha256: string;
  /** Edge lists are capped per subject; totals live on the subject's own row. */
  edges_per_subject: number;
  caveats: Bilingual extends never ? never : { en: string[]; "zh-CN": string[] };
};


/**
 * One kind of work in a market: what an update lands on. Nothing is graded.
 * `updates` counts the published updates linked to it, 0 when none is.
 */
export type Activity = {
  activity_id: string;
  label_en: string;
  label_zh_cn: string | null;
  market_id: string;
  market_en: string;
  market_zh_cn: string | null;
  /** Occupation tasks the work is proposed to cover. */
  tasks: number;
  updates: number;
};

/** A post by someone other than the vendor that said the same: recorded, not verified. */
export type LinkPost = {
  source_id: string;
  account_key: string;
  handle: string | null;
  url: string | null;
  posted_at: string | null;
  post_nature: string;
};

/** An update a judge linked to a kind of work, with the posts that also said so. */
export type WorkLink = {
  activity_id: string;
  confirmations: LinkPost[];
};

/** A link with its work and its update resolved, for rendering. */
export type Link = WorkLink & {
  event_id: string;
  activity_en: string;
  activity_zh_cn: string | null;
  market_id: string | null;
  title: string;
  summary: string;
  occurred_at: string | null;
  announced_at?: string;
  org_name: string | null;
  source_urls: string[];
};

/** An update linked to at least one kind of work, with how many it reached. */
export type LinkedEvent = Omit<EventRow, "source_urls"> & {
  source_urls: string[];
  activities: number;
  markets: number;
};

/** Which occupations serve a market. Many-to-many in both directions. */
export type MarketEdge = {
  market_id: string;
  occupation_id: string;
  confidence: number | null;
  status: string;
  occupation_en: string;
  occupation_zh_cn: string | null;
};

/**
 * One occupation of the catalog. `touched_tasks` are its tasks covered by at
 * least one kind of work some collected update was linked to: a statement about
 * the collection, not about what AI can do.
 */
export type OccupationRow = {
  id: string;
  label_en: string;
  label_zh_cn: string | null;
  group_id: string | null;
  group_en: string | null;
  group_zh_cn: string | null;
  tasks: number;
  touched_tasks: number;
  markets: { market_id: string; confidence: number | null; status: string }[];
};

/** An occupation group with its tasks summed over its occupations. */
export type OccupationGroup = {
  id: string;
  label_en: string | null;
  label_zh_cn: string | null;
  tasks: number;
  touched_tasks: number;
};

/** Percent of `tasks` that at least one collected update touches. Zero tasks is zero, not a division. */
export function touchedShare(touched: number, tasks: number): number {
  return tasks > 0 ? Math.round((touched / tasks) * 100) : 0;
}

export type EventRow = {
  event_id: string;
  title: string;
  summary: string;
  kind: string | null;
  kind_vocabulary: string;
  unresolved_reason: string | null;
  subject_key: string | null;
  identity_confidence: string | null;
  occurred_at: string | null;
  /** Only when `occurred_at` is null: the earliest source post's publication time. Older releases lack it. */
  announced_at?: string;
  confidence: number | null;
  primary_org_id: string | null;
  org_name: string | null;
  org_name_zh_cn: string | null;
  source_count: number;
  /** The original posts, so a reader can go to the source instead of to us. */
  source_urls: string[] | null;
  /** Reach of the source posts when the snapshot was taken. Never an input to a level. */
  attention?: { views: number | null; likes: number | null; provisional?: boolean } | null;
  /** The kinds of work a judge linked it to. Absent in releases before Issue #35. */
  work?: WorkLink[];
  /** What it says happened, recorded since event_kind 2.1.0; null on older rows and for kinds that carry none. */
  subject?: string | null;
  basis?: string | null;
  task?: string | null;
  result?: string | null;
  /** Figures the post states, each with the words it was read from. */
  facts?: EventFact[] | null;
};

/** One figure an update states: its value as written, the post's words for it, and what it measures. */
export type EventFact = { value: string; unit: string | null; what: string; quote: string };

/**
 * What was looked at, and what was not. Every number here is about the
 * collection, never about AI's ability: an untouched market means no update
 * was read that mentioned it.
 */
export type Coverage = {
  work_items_total: number;
  activities_total: number;
  activities_with_evidence: number;
  activities_with_tasks: number;
  activities_behind_a_gate: number;
  /** Updates read, and the smaller number that bore on any activity at all. */
  events_routed: number;
  events_bearing_on_activity: number;
  readings_taken: number;
  collection_window: { first: string | null; last: string | null; events: number };
  /** The skew a reader has to see before reading anything else. */
  events_by_organisation: { org: string; events: number }[];
  event_kinds: { kind_vocabulary: string; kind: string; n: number }[];
  /**
   * The event table holds two generations of the same collection window. Only the
   * current vocabulary is published; the superseded generation is listed here so a
   * halved count can say where the other half went.
   */
  event_generations: {
    vocabulary: string;
    events: number;
    source_posts: number;
    published: boolean;
    source_posts_also_in_current: number | null;
  }[];
  judgment_runs: {
    run_id: string;
    judge: string;
    model: string;
    task: string;
    method_version: string;
    status: string;
    item_count: number | null;
    decided_count: number | null;
    started_at: string;
    finished_at: string | null;
  }[];
  runs_in_progress: {
    run_id: string;
    judge: string;
    task: string;
    item_count: number | null;
    started_at: string;
  }[];
};

/** One post an account wrote itself, in its original language. */
export type SourcePost = {
  source_id: string;
  url: string;
  published_at: string;
  excerpt: string;
  language: string | null;
  likes: number | null;
  views: number | null;
  metrics_at: string;
};

/**
 * One account we collect from, with its owner. `posts` and `latest_post_at`
 * are null when nothing was collected from it - not the same as silence.
 * `followers` is what the platform reported at `followers_at`; `avatar_url`
 * is the platform's own image address and is display only.
 */
export type Source = {
  account_key: string;
  handle: string;
  platform: string;
  owner_kind: "person" | "organization";
  panel_role: string;
  identity_grade: string;
  identity_url: string | null;
  language: string | null;
  focus: string | null;
  avatar_url: string | null;
  person_id: string | null;
  org_id: string | null;
  name: string;
  name_zh_cn: string | null;
  affiliations: { org_id: string | null; org_name: string; relation: string; role_title: string | null }[];
  followers: number | null;
  followers_at: string | null;
  posts: number | null;
  latest_post_at: string | null;
  latest: SourcePost[];
};

/** One answer a reader can pick for a topic, with who argued it and what a judge found to weigh on it. */
export type TopicOption = {
  option_id: string;
  key: string;
  position: number;
  text: Bilingual;
  /** Accounts that argued this answer in the posts collected; not a count of who thinks so. */
  accounts: number;
  panel_accounts: number;
  supports: number;
  contradicts: number;
};

/** A post whose author asserts one answer. `account_key` is set only for an account the panel has confirmed. */
export type TopicClaim = {
  source_id: string;
  option: string;
  handle: string;
  account_key: string | null;
  url: string | null;
  published_at: string;
  says: string;
  /** The post's own words, in its own language. */
  quote: string | null;
  views: number | null;
};

/** An update a judge found to weigh for or against one answer. No answer is declared right. */
export type TopicEvidence = {
  event_id: string;
  option: string;
  sign: "supports" | "contradicts";
  confidence: number;
  title: string;
  kind: string | null;
  occurred_at: string | null;
  by: string | null;
  source_url: string | null;
};

/** A closed question about one job or one kind of business. It carries no answer of its own. */
export type Topic = {
  topic_id: string;
  slug: string;
  question_type: "replacement" | "viability";
  object: string;
  question: Bilingual;
  state: string;
  origin: string;
  sides: "open" | "one_sided";
  about: ({ id: string; kind: string | null } & Bilingual) | null;
  /** The occupation group or market group it is browsed under; null when the catalog has no entry for it. */
  group?: ({ id: string } & Bilingual) | null;
  opened_at: string;
  latest_claim_at: string | null;
  accounts: number;
  posts: number;
  options: TopicOption[];
  claims: TopicClaim[];
  evidence: TopicEvidence[];
  /** Accounts arguing each answer, by calendar quarter (UTC). */
  by_quarter: Record<string, Record<string, number>>;
};

// ------------------------------------------------------- before Issue #35 ----
//
// Releases made before the ungraded collections (`work`, `occupations`,
// `Event.work`) carry the same catalogue and links inside the graded chain and
// progress documents. They are read only to fold them into the shapes above,
// and the deprecated Agent `evidence` record still shows their readings. All of
// this goes when those collections stop being published.

/** One reading as the chain stores it: an update landed on an activity, with the retired level. */
export type EvidenceRow = {
  activity_id: string;
  event_id: string;
  evidence_tier: string;
  observed_level: number | null;
  level: number | null;
  confidence: number | null;
  rationale: string;
  status: string;
  confirmations?: Confirmation[];
};

/** A confirming post as the chain stores it, with the retired level it carried. */
export type Confirmation = LinkPost & {
  evidence_tier: string;
  observed_level: number | null;
  level: number | null;
};

type ChainActivity = Omit<Activity, "updates">;

type LegacyCounts = Partial<Record<string, number>>;

type LegacyProgress = {
  groups: Record<string, { label_en: string | null; label_zh_cn: string | null; tasks: number; by_stage: LegacyCounts }>;
  occupations: Record<string, {
    group_id: string | null;
    label_en: string | null;
    label_zh_cn: string | null;
    tasks: number;
    by_stage: LegacyCounts;
  }>;
};

/** What one data release holds, shaped as the snapshot files and the release database both deliver it. */
export type Payload = {
  manifest: Manifest;
  events: EventRow[];
  coverage: Coverage;
  sources: Source[];
  /** Absent from a release made before topics were published. */
  topics?: Topic[];
  /** Absent from a release made before Issue #35; then the chain and progress below carry the same. */
  work?: (Omit<Activity, "activity_id"> & { id: string })[];
  occupations?: OccupationRow[];
  chain?: { activities: ChainActivity[]; evidence: EvidenceRow[] };
  markets?: MarketEdge[];
  progress?: LegacyProgress;
};

/** Tasks the old progress counted as reached: any level at all. */
const legacyTouched = (by: LegacyCounts) =>
  (["0", "1", "2", "3", "4", "5"] as const).reduce((sum, key) => sum + (by[key] ?? 0), 0);

const strip = ({ source_id, account_key, handle, url, posted_at, post_nature }: LinkPost): LinkPost =>
  ({ source_id, account_key, handle, url, posted_at, post_nature });

/** Every update-to-work link of a release, in the order the release gives them. */
function linksOf(data: Payload): (WorkLink & { event_id: string })[] {
  if (data.work) {
    return data.events.flatMap((e) => (e.work ?? []).map((w) => ({ event_id: e.event_id, ...w })));
  }
  const published = new Set(data.events.map((e) => e.event_id));
  return (data.chain?.evidence ?? [])
    .filter((row) => published.has(row.event_id))
    .map((row) => ({ event_id: row.event_id, activity_id: row.activity_id, confirmations: (row.confirmations ?? []).map(strip) }));
}

function workOf(data: Payload, updates: Map<string, number>): Activity[] {
  const rows: ChainActivity[] = data.work
    ? data.work.map(({ id, ...rest }) => ({ ...rest, activity_id: id }))
    : (data.chain?.activities ?? []).map(({ activity_id, label_en, label_zh_cn, market_id, market_en, market_zh_cn, tasks }) =>
        ({ activity_id, label_en, label_zh_cn, market_id, market_en, market_zh_cn, tasks }));
  return rows.map((row) => ({ ...row, updates: updates.get(row.activity_id) ?? 0 }));
}

function occupationsOf(data: Payload): { rows: OccupationRow[]; groups: OccupationGroup[] } {
  if (data.occupations) {
    const groups = new Map<string, OccupationGroup>();
    for (const row of data.occupations) {
      if (!row.group_id) continue;
      const group = groups.get(row.group_id)
        ?? { id: row.group_id, label_en: row.group_en, label_zh_cn: row.group_zh_cn, tasks: 0, touched_tasks: 0 };
      group.tasks += row.tasks;
      group.touched_tasks += row.touched_tasks;
      groups.set(row.group_id, group);
    }
    return { rows: data.occupations, groups: [...groups.values()] };
  }
  const groups = Object.entries(data.progress?.groups ?? {}).map(([id, g]) => ({
    id, label_en: g.label_en, label_zh_cn: g.label_zh_cn, tasks: g.tasks, touched_tasks: legacyTouched(g.by_stage),
  }));
  const label = new Map(groups.map((g) => [g.id, g]));
  const served = new Map<string, OccupationRow["markets"]>();
  for (const e of data.markets ?? []) {
    served.set(e.occupation_id, [...(served.get(e.occupation_id) ?? []), { market_id: e.market_id, confidence: e.confidence, status: e.status }]);
  }
  const named = new Map((data.markets ?? []).map((e) => [e.occupation_id, e]));
  const ids = new Set([...Object.keys(data.progress?.occupations ?? {}), ...served.keys()]);
  const rows = [...ids].map((id): OccupationRow => {
    const entry = data.progress?.occupations?.[id];
    const group = entry?.group_id ? label.get(entry.group_id) : undefined;
    return {
      id,
      label_en: entry?.label_en ?? named.get(id)?.occupation_en ?? id,
      label_zh_cn: entry?.label_zh_cn ?? named.get(id)?.occupation_zh_cn ?? null,
      group_id: entry?.group_id ?? null,
      group_en: group?.label_en ?? null,
      group_zh_cn: group?.label_zh_cn ?? null,
      tasks: entry?.tasks ?? 0,
      touched_tasks: entry ? legacyTouched(entry.by_stage) : 0,
      markets: served.get(id) ?? [],
    };
  });
  return { rows, groups };
}

export type DataRelease = {
  releaseId: string | null;
  source: "database" | "files" | "none";
  loadedAt: string | null;
};

/** One loaded release with the indexes folded out of it once, when it is swapped in. */
type Store = {
  data: Payload | null;
  release: DataRelease;
  work: Activity[];
  workById: Map<string, Activity>;
  /** Links in release order, each resolved against its work and its update. */
  links: Link[];
  linkedEvents: LinkedEvent[];
  occupations: OccupationRow[];
  occupationById: Map<string, OccupationRow>;
  groups: OccupationGroup[];
};

function buildStore(data: Payload | null, release: DataRelease): Store {
  const raw = data ? linksOf(data) : [];
  const updates = new Map<string, number>();
  for (const id of new Set(raw.map((l) => `${l.activity_id}\n${l.event_id}`))) {
    const activity = id.split("\n")[0];
    updates.set(activity, (updates.get(activity) ?? 0) + 1);
  }
  const work = data ? workOf(data, updates) : [];
  const workById = new Map(work.map((a) => [a.activity_id, a]));
  const eventById = new Map((data?.events ?? []).map((e) => [e.event_id, e]));
  const links = raw.map((l): Link => {
    const activity = workById.get(l.activity_id);
    const event = eventById.get(l.event_id);
    return {
      ...l,
      activity_en: activity?.label_en ?? l.activity_id,
      activity_zh_cn: activity?.label_zh_cn ?? null,
      market_id: activity?.market_id ?? null,
      title: event?.title ?? "",
      summary: event?.summary ?? "",
      occurred_at: event?.occurred_at ?? null,
      ...(event?.announced_at ? { announced_at: event.announced_at } : {}),
      org_name: event?.org_name ?? null,
      source_urls: event?.source_urls ?? [],
    };
  });
  const reach = new Map<string, { activities: Set<string>; markets: Set<string> }>();
  for (const l of links) {
    const seen = reach.get(l.event_id) ?? { activities: new Set<string>(), markets: new Set<string>() };
    seen.activities.add(l.activity_id);
    if (l.market_id) seen.markets.add(l.market_id);
    reach.set(l.event_id, seen);
  }
  const linkedEvents = (data?.events ?? [])
    .filter((e) => reach.has(e.event_id))
    .map((e) => ({ ...e, source_urls: e.source_urls ?? [], activities: reach.get(e.event_id)!.activities.size, markets: reach.get(e.event_id)!.markets.size }));
  const { rows: occupations, groups } = data ? occupationsOf(data) : { rows: [], groups: [] };
  return {
    data,
    release,
    work,
    workById,
    links,
    linkedEvents,
    occupations,
    occupationById: new Map(occupations.map((o) => [o.id, o])),
    groups,
  };
}

/**
 * The store sits on `globalThis` because the instrumentation hook and the route
 * handlers are separate bundles with separate module instances. A replacement
 * swaps this one reference, so a reader that takes the store once sees one release.
 */
const STORE = Symbol.for("openaiwill.snapshot.store");
const g = globalThis as typeof globalThis & { [STORE]?: Store };

const EMPTY = buildStore(null, { releaseId: null, source: "none", loadedAt: null });

function current(): Store {
  return g[STORE] ?? EMPTY;
}

/** Swap in a release, or `null` for a database with no active release or no data at all. */
export function replaceSnapshot(
  payload: Payload | null,
  meta: { releaseId: string | null; source: "database" | "files" | "none"; loadedAt?: string },
) {
  g[STORE] = buildStore(payload, {
    releaseId: meta.releaseId,
    source: meta.source,
    loadedAt: meta.source === "none" ? null : (meta.loadedAt ?? new Date().toISOString()),
  });
}

/** Which data release the pages are rendering from. */
export function dataRelease(): DataRelease {
  return current().release;
}

export const snapshotExists = (): boolean => current().data?.manifest != null;
export const manifest = (): Manifest | null => current().data?.manifest ?? null;
export const activities = (): Activity[] => current().work;
export const events = (): EventRow[] => current().data?.events ?? [];
export const coverage = (): Coverage | null => current().data?.coverage ?? null;
export const sources = (): Source[] => current().data?.sources ?? [];
export const topics = (): Topic[] => current().data?.topics ?? [];
export const topicBySlug = (slug: string): Topic | undefined => topics().find((t) => t.slug === slug);

/** Every update-to-work link, resolved. */
export const links = (): Link[] => current().links;

/** The updates linked to at least one kind of work: the ones with a page of their own. */
export const linkedEvents = (): LinkedEvent[] => current().linkedEvents;

/**
 * The retired readings, for the deprecated Agent `evidence` record only. Empty
 * once a release no longer carries the chain.
 */
export const legacyEvidence = (): EvidenceRow[] => current().data?.chain?.evidence ?? [];

/** Every occupation group, with its tasks and the ones an update reaches. */
export const occupationGroups = (): OccupationGroup[] => current().groups;

/** One occupation of the catalog, whether or not it has tasks. */
export function occupationById(id: string): OccupationRow | undefined {
  return current().occupationById.get(id);
}

/**
 * Where the middle occupation sits, so one occupation's share can be judged.
 *
 * A bare "41%" tells a reader nothing. The same number against a median of 0%
 * across 923 occupations is a judgement they can act on.
 */
export function occupationMedianShare(): { occupations: number; median: number } {
  const shares = current().occupations.filter((o) => o.tasks > 0).map((o) => (o.touched_tasks / o.tasks) * 100);
  if (!shares.length) return { occupations: 0, median: 0 };
  shares.sort((x, y) => x - y);
  const mid = Math.floor(shares.length / 2);
  const median = shares.length % 2 ? shares[mid] : (shares[mid - 1] + shares[mid]) / 2;
  return { occupations: shares.length, median: Math.round(median) };
}

/** Slug used in group URLs: oaw:occupation-group:11 -> 11 */
export function groupSlug(id: string): string {
  return id.replace(/^oaw:occupation-group:/, "");
}

export function groupFromSlug(slug: string): OccupationGroup | undefined {
  return current().groups.find((group) => groupSlug(group.id) === slug);
}

/** Slug used in market URLs: oaw:market:accounting-audit-assurance -> accounting-audit-assurance */
export function marketSlug(id: string): string {
  return id.replace(/^oaw:market:/, "");
}

export function activityById(id: string): Activity | undefined {
  return current().workById.get(id);
}

/** Every activity of one market, the ones most updates bear on first, those none reached last. */
export function activitiesOfMarket(marketId: string): Activity[] {
  return activities()
    .filter((a) => a.market_id === marketId)
    .sort((x, y) => y.updates - x.updates || x.label_en.localeCompare(y.label_en));
}

/** Updates that bear on at least one kind of work in each market, counted once per market. */
export function updateCountByMarket(): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const link of links()) {
    if (!link.market_id) continue;
    const set = seen.get(link.market_id) ?? new Set<string>();
    set.add(link.event_id);
    seen.set(link.market_id, set);
  }
  return new Map([...seen].map(([market, events]) => [market, events.size]));
}

/** The markets, folded out of the activity rows so there is one source for both. */
export function markets(): { id: string; en: string; zh_cn: string | null; activities: number }[] {
  const seen = new Map<string, { id: string; en: string; zh_cn: string | null; activities: number }>();
  for (const a of activities()) {
    const found = seen.get(a.market_id);
    if (found) found.activities += 1;
    else seen.set(a.market_id, { id: a.market_id, en: a.market_en, zh_cn: a.market_zh_cn, activities: 1 });
  }
  return [...seen.values()].sort((x, y) => x.en.localeCompare(y.en));
}

/** Every market-to-occupation edge, carried on the occupation rows. */
export function marketEdges(): MarketEdge[] {
  return current().occupations.flatMap((o) => o.markets.map((m) => ({
    ...m, occupation_id: o.id, occupation_en: o.label_en, occupation_zh_cn: o.label_zh_cn,
  })));
}

/** Occupations served by a market, most confident first. */
export function occupationsOfMarket(marketId: string): MarketEdge[] {
  return marketEdges()
    .filter((e) => e.market_id === marketId)
    .sort((x, y) => (y.confidence ?? 0) - (x.confidence ?? 0));
}

/** Markets one occupation serves. The reverse of the edge above. */
export function marketsOfOccupation(occupationId: string): MarketEdge[] {
  const o = occupationById(occupationId);
  return (o?.markets ?? []).map((m) => ({ ...m, occupation_id: o!.id, occupation_en: o!.label_en, occupation_zh_cn: o!.label_zh_cn }));
}

const newestFirst = (a: Link, b: Link) => (updateTimestamp(b) ?? "").localeCompare(updateTimestamp(a) ?? "");

/** Links of one kind of work, newest update first. */
export function linksOfWork(activityId: string): Link[] {
  return links().filter((l) => l.activity_id === activityId).sort(newestFirst);
}

/**
 * The work an update was linked to, if any.
 *
 * Most updates are linked to none: an update that turned out to say nothing
 * about work is a result, and the feed shows it per row.
 */
export function linksOfEvent(eventId: string): Link[] {
  return links().filter((l) => l.event_id === eventId);
}

export function occupationSlug(id: string): string {
  return id.replace(/^oaw:occupation:/, "");
}

/**
 * Occupations with tasks in the catalog, with the markets they serve, the ones
 * updates reach most first. An occupation nothing reaches still appears,
 * because a missing row and a row of blanks say different things.
 */
export function occupations() {
  const rows = current().occupations
    .filter((o) => o.tasks > 0)
    .map((o) => ({
      occupation_id: o.id,
      group_id: o.group_id,
      label_en: o.label_en,
      label_zh_cn: o.label_zh_cn,
      tasks: o.tasks,
      touched: o.touched_tasks,
      markets: o.markets.map((m) => m.market_id),
    }));
  return rows.sort((a, b) => b.touched - a.touched || b.tasks - a.tasks);
}
