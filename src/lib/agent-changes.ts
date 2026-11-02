import type { Language } from "./i18n";
import { absoluteUrl } from "./seo";
import {
  candidateView,
  filterObservations,
  observationCounts,
  observationSummary,
  pagePath,
  pagesOf,
  sortObservations,
  type ObservationFilter,
} from "./agent-observations";
import { dataRelease, linkedEvents, markets, observationsPublished, occupations, topics, type ObservationRow } from "./snapshot";

/**
 * What changed since a data release or a moment (Issue #29, `changes_since`). Only the loaded release is in
 * memory, so every answer is read from the timestamps it carries, each chosen so that nothing listed can have
 * been in the earlier release: an observation first recorded after the moment, a source or a topic claim
 * published after it, a review made after it, a topic opened after it. Updates carry no recorded time, so
 * those listed are the ones that happened after the moment: a lower bound, and the answer says so.
 */

/** `<generated_at UTC YYYYMMDDTHHMMSSZ>-<content_sha256[:8]>`, as `kg.py` names a release. */
const RELEASE_ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export type Since = { given: string; basis: "release" | "date" | "time"; at: string };

/** A release id, a day (from its start, UTC) or an instant with its offset; null when it is none of them. */
export function parseSince(given: string): Since | null {
  const release = RELEASE_ID.exec(given);
  const at = release
    ? `${release[1]}-${release[2]}-${release[3]}T${release[4]}:${release[5]}:${release[6]}Z`
    : DAY.test(given) ? `${given}T00:00:00Z`
    : INSTANT.test(given) ? given
    : null;
  if (!at || Number.isNaN(Date.parse(at))) return null;
  return { given, basis: release ? "release" : DAY.test(given) ? "date" : "time", at: new Date(Date.parse(at)).toISOString() };
}

const after = (value: string | null | undefined, at: number) => !!value && Date.parse(value) > at;

type Concept = NonNullable<ObservationFilter["occupation"]>;

/** How many of the rows each occupation or market page lists, most first. */
function touchedPages(rows: ObservationRow[], language: Language, limit: number) {
  const counts = new Map<string, { kind: "occupation" | "market"; id: string; slug: string; n: number }>();
  for (const row of rows) {
    for (const page of pagesOf(row)) {
      const key = `${page.kind}:${page.id}`;
      const seen = counts.get(key) ?? { ...page, n: 0 };
      seen.n += 1;
      counts.set(key, seen);
    }
  }
  const label = (kind: "occupation" | "market", id: string) => {
    if (kind === "occupation") {
      const o = occupations().find((row) => row.occupation_id === id);
      return { label: o?.label_en ?? null, label_zh_cn: o?.label_zh_cn ?? null };
    }
    const m = markets().find((row) => row.id === id);
    return { label: m?.en ?? null, label_zh_cn: m?.zh_cn ?? null };
  };
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((p) => ({ kind: p.kind, id: p.id, ...label(p.kind, p.id), new_observations: p.n, url: absoluteUrl(language, pagePath(p)) }));
}

/** Rows that change between releases, read from the loaded one. Articles live outside releases: see `agent-api`. */
export function releaseChanges(input: { since: Since; occupation?: Concept; market?: Concept; limit: number; language: Language }) {
  const { since, occupation, market, limit, language } = input;
  const at = Date.parse(since.at);
  const scoped = !!(occupation || market);

  let observationPart = null;
  if (observationsPublished()) {
    const scope = filterObservations({ occupation, market });
    const recorded = sortObservations(filterObservations({ occupation, market, recordedSince: since.at }), "recorded");
    const earlier = scope.filter((r) => !after(r.created_at, at));
    const sourced = earlier.filter((r) => r.sources.some((s) => after(s.published_at, at)));
    const reviewed = scope.filter((r) => after(r.reviewed_at, at));
    observationPart = {
      recorded: {
        total: recorded.length,
        counts: observationCounts(recorded),
        pages: scoped ? null : touchedPages(recorded, language, limit),
        results: recorded.slice(0, limit).map((row) => observationSummary(row, language)),
        more: recorded.length > limit
          ? { tool: "query_observations", arguments: { recorded_since: since.at, order: "recorded", ...(occupation ? { occupation: occupation.id } : {}), ...(market ? { market: market.id } : {}) } }
          : null,
      },
      new_sources: {
        total: sourced.length,
        results: sourced.slice(0, limit).map((row) => ({
          ...observationSummary(row, language),
          new_source_urls: row.sources.filter((s) => after(s.published_at, at)).map((s) => s.url),
        })),
      },
      reviewed: {
        total: reviewed.length,
        results: reviewed.slice(0, limit).map((row) => ({ ...observationSummary(row, language), reviewed_at: row.reviewed_at })),
      },
    };
  }

  const concept = occupation ?? market;
  const inScope = topics().filter((t) => !concept || t.about?.id === concept.id);
  const opened = inScope.filter((t) => after(t.opened_at, at));
  const claimed = inScope
    .filter((t) => !after(t.opened_at, at))
    .map((t) => ({ t, claims: t.claims.filter((c) => after(c.published_at, at)) }))
    .filter(({ claims }) => claims.length > 0)
    .sort((a, b) => b.claims.length - a.claims.length || a.t.topic_id.localeCompare(b.t.topic_id));
  const topicView = (t: (typeof inScope)[number]) => ({
    id: t.topic_id,
    question: t.question[language],
    about: t.about ? { id: t.about.id, kind: t.about.kind } : null,
    opened_at: t.opened_at,
    latest_claim_at: t.latest_claim_at,
    url: absoluteUrl(language, `/topics/${t.slug}`),
  });

  const updates = linkedEvents()
    .filter((e) => after(e.occurred_at ?? e.announced_at, at))
    .sort((a, b) => Date.parse(b.occurred_at ?? b.announced_at ?? "") - Date.parse(a.occurred_at ?? a.announced_at ?? "") || a.event_id.localeCompare(b.event_id));

  return {
    since,
    scope: {
      occupation: occupation ? candidateView(occupation, language) : null,
      market: market ? candidateView(market, language) : null,
    },
    same_release: since.basis === "release" && since.given === dataRelease().releaseId,
    observations: observationPart,
    topics: {
      opened: { total: opened.length, results: opened.slice(0, limit).map(topicView) },
      new_claims: {
        total: claimed.length,
        results: claimed.slice(0, limit).map(({ t, claims }) => ({
          ...topicView(t),
          new_claims: claims.length,
          by_option: Object.fromEntries(t.options.map((o) => [o.key, claims.filter((c) => c.option === o.key).length])),
        })),
      },
    },
    // An update is not mapped to an occupation, so a scoped answer leaves updates out instead of guessing.
    updates: scoped ? null : {
      basis: "happened_after" as const,
      total: updates.length,
      results: updates.slice(0, limit).map((e) => ({
        id: e.event_id,
        title: e.title,
        date: (e.occurred_at ?? e.announced_at ?? null)?.slice(0, 10) ?? null,
        organization: e.org_name,
        url: absoluteUrl(language, `/updates/${e.event_id}`),
      })),
    },
  };
}

export const CHANGES_NOTE =
  "Everything listed was recorded or published after `since.at`, so none of it can be in an earlier release. " +
  "observations.recorded are new to the ledger (an old statement read for the first time counts); new_sources are older observations a later source now also states; " +
  "reviewed changed review state. Updates carry no recorded time: those listed happened after the moment, and an update collected late about an earlier event is not listed. " +
  "A merged observation's old id resolves with get_record. Nothing here is reviewed unless review_state says so.";
