import { updateTimestamp } from "./update-date";
import { vocabularyTerm } from "@/components/ontology-labels";
import * as snapshot from "@/lib/snapshot";

/**
 * What the homepage and `llms.txt` say about the loaded data release, built once
 * per request. Counts of collected updates and the questions people are arguing;
 * no level, no progress figure (the L0–L5 scale is retired, Issue #35).
 */
export type Both = { en: string; zh: string };

export type HomeUpdate = {
  id: string;
  title: string;
  org: string;
  /** `YYYY-MM-DD`; null when the update carries no date. */
  date: string | null;
  /** True when the date is the source announcement rather than an occurrence. */
  announced: boolean;
  kind: Both | null;
  sources: number;
};

export type HomeTopic = {
  slug: string;
  question: Both;
  type: "replacement" | "viability";
  accounts: number;
  evidence: number;
  /** More than one answer has someone arguing it. */
  open: boolean;
};

/** The home page counts the updates of the last this many days of the window. */
export const RECENT_DAYS = 30;
const LATEST = 6;
const FEATURED_TOPICS = 4;

export type HomeData = {
  /** First day of the collection window. */
  start: string;
  generatedAt: string;
  orgsTracked: number;
  updatesTotal: number;
  /** Dated updates within `RECENT_DAYS` of the last day of the window; undated ones are not counted. */
  recentUpdates: number;
  latest: HomeUpdate[];
  topicsTotal: number;
  topics: HomeTopic[];
};

const DAY = 24 * 60 * 60 * 1000;
const dayOf = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/** Null when there is no snapshot or it has no dated window: the page then says so instead of drawing empty figures. */
export function buildHomeData(): HomeData | null {
  const manifest = snapshot.manifest();
  const coverage = snapshot.coverage();
  const events = snapshot.events();
  const times = events.map(updateTimestamp).filter((at): at is string => Boolean(at));
  const first = [coverage?.collection_window.first, ...times].filter((at): at is string => Boolean(at)).sort()[0];
  const last = [coverage?.collection_window.last, ...times].filter((at): at is string => Boolean(at)).sort().at(-1);
  if (!manifest || !coverage || !first || !last) return null;

  const end = dayOf(last);
  const dated = events.map((e) => ({ e, date: updateTimestamp(e)?.slice(0, 10) ?? null }));
  const latest: HomeUpdate[] = dated
    .filter((row): row is { e: (typeof events)[number]; date: string } => row.date !== null)
    .sort((a, b) => b.date.localeCompare(a.date) || a.e.event_id.localeCompare(b.e.event_id))
    .slice(0, LATEST)
    .map(({ e, date }) => {
      const term = vocabularyTerm("event_kind", e.kind);
      return {
        id: e.event_id,
        title: e.title,
        org: e.org_name ?? "",
        date,
        announced: !e.occurred_at && Boolean(e.announced_at),
        kind: term?.en ? { en: term.en, zh: term["zh-CN"] ?? term.en } : null,
        sources: e.source_count,
      };
    });

  const topics = snapshot.topics();
  const argued = (a: snapshot.Topic, b: snapshot.Topic) => b.accounts - a.accounts || b.evidence.length - a.evidence.length || a.slug.localeCompare(b.slug);
  const featured = topics.filter((t) => t.sides === "open").sort(argued).slice(0, FEATURED_TOPICS);

  return {
    start: first.slice(0, 10),
    generatedAt: manifest.generated_at.slice(0, 10),
    orgsTracked: coverage.events_by_organisation.length,
    updatesTotal: events.length,
    recentUpdates: dated.filter((row) => row.date !== null && end - dayOf(row.date) < RECENT_DAYS * DAY).length,
    latest,
    topicsTotal: topics.length,
    topics: featured.map((t) => ({
      slug: t.slug,
      question: { en: t.question.en, zh: t.question["zh-CN"] },
      type: t.question_type,
      accounts: t.accounts,
      evidence: t.evidence.length,
      open: t.sides === "open",
    })),
  };
}
