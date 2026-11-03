import { updateTimestamp } from "./update-date";
import { vocabularyTerm } from "@/components/ontology-labels";
import { pagePath, pagesOf } from "@/lib/agent-observations";
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

/** One observation as the home page shows it, with the page that lists it. */
export type HomeObservation = {
  row: snapshot.ObservationRow;
  /** Where it is listed, without a language prefix: its occupation or market page at its row, else its update. */
  path: string;
  /** The occupation or market that page is about; null for the update. */
  where: Both | null;
};

/** The home page counts the updates of the last this many days of the window. */
export const RECENT_DAYS = 30;
const LATEST = 6;
const FEATURED_TOPICS = 4;
const LATEST_OBSERVATIONS = 6;

export type HomeData = {
  /** First day of the collection window. */
  start: string;
  generatedAt: string;
  orgsTracked: number;
  updatesTotal: number;
  /** Dated updates within `RECENT_DAYS` of the last day of the window; undated ones are not counted. */
  recentUpdates: number;
  latest: HomeUpdate[];
  /** Null when the release carries no observations at all (before Issue #25), as opposed to an empty list. */
  observationsTotal: number | null;
  /** The newest dated observations that have a page to read them on, strongest evidence first within a day. */
  latestObservations: HomeObservation[];
  topicsTotal: number;
  topics: HomeTopic[];
};

const DAY = 24 * 60 * 60 * 1000;
const dayOf = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

function newestObservations(): HomeObservation[] {
  const updates = new Set(snapshot.events().map((e) => e.event_id));
  const found: HomeObservation[] = [];
  const rows = snapshot.observations().filter((row) => snapshot.observationDate(row) && row.review_state !== "human_rejected");
  rows.sort((a, b) => (snapshot.observationDate(b) ?? "").localeCompare(snapshot.observationDate(a) ?? "") || snapshot.byStrength(a, b));
  for (const row of rows) {
    const page = pagesOf(row)[0];
    if (page) {
      const name = page.kind === "occupation"
        ? snapshot.occupations().find((o) => o.occupation_id === page.id)
        : snapshot.markets().find((m) => m.id === page.id);
      const en = name && ("label_en" in name ? name.label_en : name.en);
      const zh = name && ("label_zh_cn" in name ? name.label_zh_cn : name.zh_cn);
      found.push({ row, path: `${pagePath(page)}#${row.observation_id}`, where: en ? { en, zh: zh ?? en } : null });
    } else if (row.event_id && updates.has(row.event_id)) {
      found.push({ row, path: `/updates/${row.event_id}`, where: null });
    }
    if (found.length === LATEST_OBSERVATIONS) break;
  }
  return found;
}

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
    observationsTotal: snapshot.observationsPublished() ? snapshot.observations().length : null,
    latestObservations: snapshot.observationsPublished() ? newestObservations() : [],
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
