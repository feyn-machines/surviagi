import { updateTimestamp } from "./update-date";
import { LEVEL_NAMES } from "@/lib/level-names";
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

export type Gate = {
  gate_id: string;
  gate_type: string;
  label_en: string;
  label_zh_cn: string | null;
  definition_en: string;
  definition_zh_cn: string | null;
  status: string | null;
  state_rationale: string | null;
  state_as_of: string | null;
  source_event_id: string | null;
  candidate_activities: number;
  reviewed_activities: number;
};

/**
 * One activity: what a market actually does, and the only thing a judge scores.
 *
 * `level` is the highest an evidence row supports after its tier cap, or null
 * when no update has said anything about this activity. An activity held by a
 * gate reads 0 with `gated: true` — a different statement from "nobody looked",
 * which is `level: null`, and from "the evidence says AI takes no part", which
 * is a 0 with `gated: false`.
 */
export type Activity = {
  activity_id: string;
  label_en: string;
  label_zh_cn: string | null;
  market_id: string;
  market_en: string;
  market_zh_cn: string | null;
  level: number | null;
  best_tier: string | null;
  evidence_rows: number | null;
  gated: boolean;
  tasks: number;
  gates: number;
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

/** Which tasks an activity covers. The edge the grid is drawn from. */
export type TaskEdge = {
  activity_id: string;
  task_id: string;
  confidence: number | null;
  status: string;
};

/**
 * One reading, as the chain stores it: an update landed on an activity.
 *
 * `observed_level` is what the judge proposed; `level` is what survives the
 * evidence tier's cap and is the only one the site stands behind. They differ
 * for 162 of the 710 readings, so a page that shows one without the other is
 * showing the largest single effect in the method as if it were not there.
 */
export type EvidenceRow = {
  activity_id: string;
  event_id: string;
  evidence_tier: string;
  observed_level: number | null;
  level: number | null;
  confidence: number | null;
  rationale: string;
  status: string;
  /** Posts by others that confirmed this reading; absent when none did, and in releases before 2026-10-16. */
  confirmations?: Confirmation[];
};

/**
 * One post by someone other than the vendor that confirmed a reading: a hands-on
 * test, an independent evaluation. It counts toward the activity's level under its
 * own tier and the cap of its kind of post, so it can carry a level the vendor's
 * own claim could not - and a page showing that level has to show it.
 */
export type Confirmation = {
  source_id: string;
  account_key: string;
  handle: string | null;
  url: string | null;
  posted_at: string | null;
  post_nature: string;
  evidence_tier: string;
  observed_level: number | null;
  level: number | null;
};

/** A reading with its activity and its update resolved, for rendering. */
export type Reading = EvidenceRow & {
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

/**
 * One update that bore on some activity, with what it reached rolled up.
 *
 * Only the 256 updates that produced a reading are here. The other 325 read as
 * updates that turned out to say nothing about work; they are on /updates,
 * because an update that landed on nothing is a result and not a gap.
 */
export type ChainEvent = {
  event_id: string;
  title: string;
  summary: string;
  occurred_at: string | null;
  org_name: string | null;
  primary_org_id: string | null;
  activities: number;
  markets: number;
  top_level: number | null;
  best_tier: string | null;
  source_urls: string[];
  /** Only when `occurred_at` is null: the earliest source post's publication time. Older releases lack it. */
  announced_at?: string;
};

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
};

/**
 * How far AI has got, counted in distinct work items rather than in edges.
 *
 * L0-L5 plus two kinds of blank, and the blanks are not the same finding.
 * `unknown` is a task covered by an activity that has no evidence behind it, so
 * the lowest level among its activities cannot be known. `untouched` is a task
 * no activity covers at all. Neither is zero, and a chart that merges them says
 * "AI cannot do this" where the truth is "nobody has looked".
 */
export type StageCounts = Partial<
  Record<"0" | "1" | "2" | "3" | "4" | "5" | "unknown" | "untouched", number>
>;

export type Coverage3 = "assessed" | "unknown" | "untouched";

export type MarketProgress = {
  label_en: string | null;
  label_zh_cn: string | null;
  tasks: number;
  by_stage: StageCounts;
};

export type Progress = {
  method_version: string;
  /** Published even where empty: an absent L5 is the headline, not a gap. */
  stages: number[];
  /** The ladder's own words, projected from the schema's activity_level. */
  levels: Record<string, Bilingual>;
  /** The full sentence per rung, so no component restates the ladder. */
  level_definitions: Record<string, Bilingual>;
  states: Coverage3[];
  /** What each kind of evidence is allowed to support, so an absent L3 reads. */
  tier_caps: Record<"T1" | "T2" | "T3" | "T4", number>;
  work_items_total: number;
  assessed: number;
  unknown: number;
  untouched: number;
  global: { stage: number | null; coverage: Coverage3; work_items: number }[];
  /** One level up from occupations: few enough rows to compare at a glance. */
  groups: Record<string, {
    label_en: string | null;
    label_zh_cn: string | null;
    tasks: number;
    by_stage: StageCounts;
  }>;
  occupations: Record<string, {
    group_id: string | null;
    label_en: string | null;
    label_zh_cn: string | null;
    tasks: number;
    by_stage: StageCounts;
  }>;
  /** The market axis: kinds of work, which is what an update actually lands on. */
  markets: Record<string, MarketProgress>;
};

/** Work an update has been shown to reach, at any level above none. */
export function assessedCount(by: StageCounts): number {
  return (["0", "1", "2", "3", "4", "5"] as const)
    .reduce((sum, key) => sum + (by[key] ?? 0), 0);
}

/**
 * Work AI produces the bulk of or better: L2 and up.
 *
 * L2 is the line where a person stops doing the work and starts checking it.
 * Below it AI is an assistant; at or above it the output is AI's and the human
 * role is review. That is the threshold a reader is asking about.
 */
export function atOrAboveL2(by: StageCounts): number {
  return (["2", "3", "4", "5"] as const)
    .reduce((sum, key) => sum + (by[key] ?? 0), 0);
}

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

/**
 * One file, because the homepage reads a chain and not three tables: an update
 * produced a reading, the reading landed on an activity, the activity belongs
 * to a market and may be held by a gate. It replaces activities.json /
 * evidence.json / gates.json rather than sitting beside them - two copies of
 * the same 710 readings would eventually disagree.
 */
type Chain = {
  events: ChainEvent[];
  evidence: EvidenceRow[];
  activities: Activity[];
  gates: Gate[];
  gate_edges: GateEdge[];
};

/** One activity held by one gate. The counts alone could not name an example. */
export type GateEdge = {
  gate_id: string;
  activity_id: string;
  confidence: number | null;
  status: string;
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

/** What one data release holds, shaped as the snapshot files and the release database both deliver it. */
export type Payload = {
  chain: Chain;
  manifest: Manifest;
  markets: MarketEdge[];
  tasks: TaskEdge[];
  events: EventRow[];
  coverage: Coverage;
  progress: Progress;
  sources: Source[];
  /** Absent from a release made before topics were published. */
  topics?: Topic[];
};

export type DataRelease = {
  releaseId: string | null;
  source: "database" | "files" | "none";
  loadedAt: string | null;
};

/** One loaded release with the indexes folded out of it once, when it is swapped in. */
type Store = {
  data: Payload | null;
  release: DataRelease;
  chainEventById: Map<string, ChainEvent>;
  activityIndex: Map<string, Activity>;
  progress: Progress | null;
};

function buildStore(data: Payload | null, release: DataRelease): Store {
  const published = data?.progress ?? null;
  return {
    data,
    release,
    chainEventById: new Map((data?.chain.events ?? []).map((e) => [e.event_id, e])),
    activityIndex: new Map((data?.chain.activities ?? []).map((a) => [a.activity_id, a])),
    /**
     * The snapshot still carries the earlier wording of the level names. Pages read
     * the names from here, so the ruler is replaced once, on the way in, with v4.
     */
    progress: published && {
      ...published,
      levels: Object.fromEntries(
        LEVEL_NAMES.en.map((en, level) => [String(level), { en, "zh-CN": LEVEL_NAMES["zh-CN"][level] }]),
      ),
    },
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
export const activities = (): Activity[] => current().data?.chain.activities ?? [];
export const gates = (): Gate[] => current().data?.chain.gates ?? [];
export const evidence = (): EvidenceRow[] => current().data?.chain.evidence ?? [];
export const chainEvents = (): ChainEvent[] => current().data?.chain.events ?? [];
export const gateEdges = (): GateEdge[] => current().data?.chain.gate_edges ?? [];
export const marketEdges = (): MarketEdge[] => current().data?.markets ?? [];
export const taskEdges = (): TaskEdge[] => current().data?.tasks ?? [];
export const events = (): EventRow[] => current().data?.events ?? [];
export const coverage = (): Coverage | null => current().data?.coverage ?? null;
export const progress = (): Progress | null => current().progress;
export const sources = (): Source[] => current().data?.sources ?? [];
export const topics = (): Topic[] => current().data?.topics ?? [];
export const topicBySlug = (slug: string): Topic | undefined => topics().find((t) => t.slug === slug);

/**
 * Where the middle occupation sits, so one occupation's share can be judged.
 *
 * A bare "41%" tells a reader nothing. The same number against a median of 33%
 * across 923 occupations is a judgement they can act on.
 */
export function occupationMedianShare(): { occupations: number; median: number } {
  const shares: number[] = [];
  for (const entry of Object.values(progress()?.occupations ?? {})) {
    const total = entry.tasks;
    if (!total) continue;
    shares.push((atOrAboveL2(entry.by_stage) / total) * 100);
  }
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

export function groupFromSlug(slug: string) {
  const entries = Object.entries(progress()?.groups ?? {});
  const found = entries.find(([id]) => groupSlug(id) === slug);
  return found ? { id: found[0], ...found[1] } : undefined;
}

/** Squares for one occupation, or null when it is not in the snapshot. */
export function progressFor(occupationId: string): StageCounts | null {
  const entry = progress()?.occupations?.[occupationId];
  return entry ? entry.by_stage : null;
}

/** Slug used in market URLs: oaw:market:accounting-audit-assurance -> accounting-audit-assurance */
export function marketSlug(id: string): string {
  return id.replace(/^oaw:market:/, "");
}

export function activityById(id: string): Activity | undefined {
  return current().activityIndex.get(id);
}

/** Every activity of one market, strongest evidence first, blanks last. */
export function activitiesOfMarket(marketId: string): Activity[] {
  return activities()
    .filter((a) => a.market_id === marketId)
    .sort((x, y) => (y.level ?? -1) - (x.level ?? -1));
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

/** Occupations served by a market, most confident first. */
export function occupationsOfMarket(marketId: string): MarketEdge[] {
  return marketEdges()
    .filter((e) => e.market_id === marketId)
    .sort((x, y) => (y.confidence ?? 0) - (x.confidence ?? 0));
}

/** Markets one occupation serves. The reverse of the edge above. */
export function marketsOfOccupation(occupationId: string): MarketEdge[] {
  return marketEdges().filter((e) => e.occupation_id === occupationId);
}

/** Resolve a stored reading against its activity and its update, in the store the caller took. */
function reading(store: Store, row: EvidenceRow): Reading {
  const activity = store.activityIndex.get(row.activity_id);
  const event = store.chainEventById.get(row.event_id);
  return {
    ...row,
    activity_en: activity?.label_en ?? row.activity_id,
    activity_zh_cn: activity?.label_zh_cn ?? null,
    market_id: activity?.market_id ?? null,
    title: event?.title ?? "",
    summary: event?.summary ?? "",
    occurred_at: event?.occurred_at ?? null,
    announced_at: event?.announced_at,
    org_name: event?.org_name ?? null,
    source_urls: event?.source_urls ?? [],
  };
}

/** The gates holding one activity. */
export function gatesOfActivity(activityId: string): string[] {
  return gateEdges().filter((e) => e.activity_id === activityId).map((e) => e.gate_id);
}

/** The activities one gate holds, most confident first. */
export function activitiesOfGate(gateId: string): string[] {
  return gateEdges().filter((e) => e.gate_id === gateId).map((e) => e.activity_id);
}

/** Every reading, joined. The chain stores positive readings only. */
export function readings(): Reading[] {
  const store = current();
  return (store.data?.chain.evidence ?? []).map((row) => reading(store, row));
}

/** Readings for one activity, newest update first. */
export function evidenceForActivity(activityId: string): Reading[] {
  const store = current();
  return (store.data?.chain.evidence ?? [])
    .filter((row) => row.activity_id === activityId)
    .map((row) => reading(store, row))
    .sort((a, b) => (updateTimestamp(b) ?? "").localeCompare(updateTimestamp(a) ?? ""));
}

/**
 * The readings that count toward an activity's level: those with a level of their
 * own, and those a confirmation lifted. Newest update first, as on the work page.
 */
export function countedReadings(activityId: string): Reading[] {
  return evidenceForActivity(activityId).filter((r) => r.level !== null || (r.confirmations?.length ?? 0) > 0);
}

/** One rise in a work's level: the reading that first carried it there, dated by the evidence. */
export type LevelStep = {
  /** When the update or post appeared; null for evidence with no date, which is placed last. */
  date: string | null;
  from: number | null;
  to: number;
  reading: Reading;
  /** Set when a post by someone else, not the update itself, carried the level. */
  confirmation: Confirmation | null;
};

/**
 * How a work reached its level, by the date of the evidence: each reading that
 * raised the highest level so far. The level is the highest counted reading, so
 * the last step always ends where the work stands. A gate holds the level below
 * what the evidence reached; every step is held the same way, by capping at the
 * level the work stands at. These are the dates the evidence carries, not the
 * dates it was collected or published here.
 */
export function levelSteps(activityId: string): LevelStep[] {
  const final = activityById(activityId)?.level ?? null;
  if (final === null) return [];
  const seen: Omit<LevelStep, "from">[] = [];
  for (const reading of countedReadings(activityId)) {
    if (reading.level !== null) seen.push({ date: reading.occurred_at, to: reading.level, reading, confirmation: null });
    for (const confirmation of reading.confirmations ?? []) {
      if (confirmation.level !== null) seen.push({ date: confirmation.posted_at, to: confirmation.level, reading, confirmation });
    }
  }
  // Oldest first; on one day the higher reading first, so a day makes one step.
  const dated = seen.filter((s) => s.date).sort((a, b) => a.date!.localeCompare(b.date!) || b.to - a.to);
  const undated = seen.filter((s) => !s.date).sort((a, b) => b.to - a.to);
  const steps: LevelStep[] = [];
  let level: number | null = null;
  for (const candidate of [...dated, ...undated]) {
    const to = Math.min(candidate.to, final);
    if (level !== null && to <= level) continue;
    steps.push({ ...candidate, from: level, to });
    level = to;
  }
  return steps;
}

export function occupationSlug(id: string): string {
  return id.replace(/^oaw:occupation:/, "");
}

/**
 * The evidence an update produced, if any.
 *
 * Most updates produce none: 325 of the 581 routed updates bore on no activity
 * at all. That ratio is the honest shape of this source, so the feed shows it
 * per row rather than listing only the updates that happened to land.
 */
export function evidenceForEvent(eventId: string): Reading[] {
  const store = current();
  return (store.data?.chain.evidence ?? [])
    .filter((row) => row.event_id === eventId)
    .map((row) => reading(store, row))
    .sort((a, b) => (b.level ?? -1) - (a.level ?? -1));
}

/** Event ids that produced at least one reading, for counting in one pass. */
export function eventsWithEvidence(): Set<string> {
  return new Set(chainEvents().map((row) => row.event_id));
}

/**
 * Occupations the evidence reaches, with the markets that reach them.
 *
 * This used to be folded out of `impact`, one row per capability-occupation
 * pair. The path is now occupation -> market -> activity -> task, and the task
 * counts come from the published progress rather than being recomputed here:
 * a second count of the same thing is a second answer waiting to diverge.
 */
export function occupations() {
  // One store for the whole fold, so the progress rows and the edges come from one release.
  const store = current();
  const served = new Map<string, MarketEdge[]>();
  for (const edge of store.data?.markets ?? []) {
    const list = served.get(edge.occupation_id);
    if (list) list.push(edge);
    else served.set(edge.occupation_id, [edge]);
  }
  const rows = Object.entries(store.progress?.occupations ?? {}).map(([id, entry]) => {
    return {
      occupation_id: id,
      group_id: entry.group_id,
      label_en: entry.label_en,
      label_zh_cn: entry.label_zh_cn,
      tasks: entry.tasks,
      by_stage: entry.by_stage,
      assessed: assessedCount(entry.by_stage),
      markets: (served.get(id) ?? []).map((e) => e.market_id),
    };
  });
  // Most reached first; an occupation nothing reaches still appears, because a
  // missing row and a row of blanks say different things.
  return rows.sort((a, b) => b.assessed - a.assessed || b.tasks - a.tasks);
}

/** One occupation's label, from the ontology row the publisher carries. */
export function occupationLabel(id: string): { en: string; zh_cn: string | null } | undefined {
  const entry = progress()?.occupations?.[id];
  if (!entry?.label_en) return undefined;
  return { en: entry.label_en, zh_cn: entry.label_zh_cn };
}
