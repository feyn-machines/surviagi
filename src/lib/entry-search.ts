import { buildAliases, findAliases, terms, type AliasTarget } from "./agent-search";
import {
  activities,
  dataRelease,
  markets,
  marketSlug,
  observationsOfMarket,
  observationsOfOccupation,
  observationsPublished,
  occupations,
  occupationSlug,
} from "./snapshot";

/**
 * What the home page's two questions land on (Issue #32): the occupations or markets a reader's words name,
 * best first. "客服" is an other name of Customer Service Representatives, not of the passenger attendants
 * whose Chinese name happens to contain it, and "pest control" is a market whose name says "pest
 * management". So an occupation is found by its own names and its other names (Occupation.alt_label, with
 * the same rule as Agent search: a name of more than three occupations names none), a market by its name and
 * the names of its kinds of work, and the words are matched as Agent search splits them. Read on the server
 * from the loaded release; the lists below the matches keep their own plain filter.
 */

export type EntryMatch = {
  id: string;
  slug: string;
  en: string;
  zh: string | null;
  /** The other name the query used, when that is how the occupation was found. */
  via: string | null;
  /** Null when the release carries no observations. */
  observations: number | null;
};

/** How many matches a page lists. */
const MATCHES = 6;
/** A match must score at least this share of the best one. */
const NEAR = 0.5;

/**
 * Words of the two questions themselves, which name no job and no business: "will AI replace accountants",
 * "AI 会取代客服吗", "我这门生意还值得做吗".
 */
const ASKING = new Set(["ai", "replace", "replaced", "replacing", "take", "taken", "takes", "over", "my", "job", "jobs", "work", "business", "still", "worth", "can", "could", "would", "should"]);
const ASKING_ZH = /人工智能|会不会|取代|替代|接手|抢走|还值得|值得|还能|能不能|我的|我这门|这门|生意|吗|呢/gu;

/** The query's terms less the asking words; a lone Chinese character ("会", "被") is left out, being part of too many names. */
function queryTerms(query: string): string[] {
  return terms(query.replace(ASKING_ZH, " ")).filter((t) => !ASKING.has(t) && !/^\p{Script=Han}$/u.test(t));
}

type Field = { text: string; weight: number };
const lower = (text: string | null | undefined) => (text ?? "").normalize("NFKC").toLowerCase();
const isHan = (term: string) => /\p{Script=Han}/u.test(term);

/** A Chinese pair anywhere; a Latin word only where a word starts, so "art" is not found in "start". */
function holds(text: string, term: string): boolean {
  if (isHan(term)) return text.includes(term);
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1])) return true;
  return false;
}

/**
 * Each term counts the weight of the heaviest field it occurs in, times how rare it is among the candidates, so
 * "pest" outweighs "control" in "pest control"; the score is the share of the most the query could get.
 */
function scorer(asked: string[], candidates: Field[][]) {
  const rarity = asked.map((term) => {
    const holding = candidates.filter((fields) => fields.some((f) => holds(f.text, term))).length;
    return Math.log((candidates.length + 1) / (holding + 0.5));
  });
  const most = rarity.reduce((sum, r) => sum + r, 0);
  return (fields: Field[]) => {
    const top = Math.max(...fields.map((f) => f.weight));
    let sum = 0;
    asked.forEach((term, i) => {
      sum += rarity[i] * Math.max(0, ...fields.filter((f) => holds(f.text, term)).map((f) => f.weight));
    });
    return most > 0 ? sum / (most * top) : 0;
  };
}

/** Candidates with a score, best first, keeping those near the best. */
function best<T extends { score: number; observations: number | null; en: string }>(rows: T[]): T[] {
  const scored = rows.filter((r) => r.score > 0).sort((a, b) => b.score - a.score || (b.observations ?? 0) - (a.observations ?? 0) || a.en.localeCompare(b.en));
  const floor = (scored[0]?.score ?? 0) * NEAR;
  return scored.filter((r) => r.score >= floor).slice(0, MATCHES);
}

let aliasIndex: { key: string; index: Map<string, AliasTarget[]> } | null = null;

function aliases(): Map<string, AliasTarget[]> {
  const release = dataRelease();
  const key = `${release.releaseId}|${release.loadedAt}`;
  if (aliasIndex?.key !== key) aliasIndex = { key, index: buildAliases(occupations()) };
  return aliasIndex.index;
}

/** The occupations a query names: by an other name first (its own word wins), then by their own names. */
export function entryOccupations(query: string): EntryMatch[] {
  const published = observationsPublished();
  const count = (id: string) => (published ? observationsOfOccupation(id).length : null);
  const via = new Map<string, string>();
  for (const found of findAliases(query, aliases())) for (const o of found.occupations) if (!via.has(o.id)) via.set(o.id, found.term);
  const asked = queryTerms(query);
  const listed = occupations();
  const fields = listed.map((o): Field[] => [{ text: lower(o.label_en), weight: 1 }, { text: lower(o.label_zh_cn), weight: 1 }]);
  const score = scorer(asked, fields);
  const rows = listed.map((o, i) => {
    const own = asked.length ? score(fields[i]) : 0;
    // An other name in the query outranks any share of words of an own name.
    return { id: o.occupation_id, en: o.label_en, zh: o.label_zh_cn, own, score: via.has(o.occupation_id) ? 1 + own : own, observations: count(o.occupation_id) };
  });
  return best(rows).map((r) => ({
    id: r.id, slug: occupationSlug(r.id), en: r.en, zh: r.zh,
    // An exact own name needs no other name to explain it.
    via: r.own < 1 ? via.get(r.id) ?? null : null,
    observations: r.observations,
  }));
}

/** The markets a query names, by the market's own name first and the names of its kinds of work after. */
export function entryMarkets(query: string): EntryMatch[] {
  const asked = queryTerms(query);
  if (!asked.length) return [];
  const published = observationsPublished();
  const work = new Map<string, Field[]>();
  for (const a of activities()) work.set(a.market_id, [...(work.get(a.market_id) ?? []), { text: lower(a.label_en), weight: 1 }, { text: lower(a.label_zh_cn), weight: 1 }]);
  const listed = markets();
  const fields = listed.map((m): Field[] => [{ text: lower(m.en), weight: 2 }, { text: lower(m.zh_cn), weight: 2 }, ...(work.get(m.id) ?? [])]);
  const score = scorer(asked, fields);
  const rows = listed.map((m, i) => ({
    id: m.id, en: m.en, zh: m.zh_cn,
    score: score(fields[i]),
    observations: published ? observationsOfMarket(m.id).length : null,
  }));
  return best(rows).map((r) => ({ id: r.id, slug: marketSlug(r.id), en: r.en, zh: r.zh, via: null, observations: r.observations }));
}
