import contract from "../../public/contract/v1/index.json";
import type { Language } from "./i18n";
import { absoluteUrl } from "./seo";
import { workSlug } from "./routes";
import { termNameOrRaw } from "@/components/ontology-labels";
import { OBSERVATION_ID, observationRecord, pagePath, pagesOf } from "./agent-observations";
import {
  activities,
  activityAnchor,
  activityById,
  linkedEvents,
  dataRelease,
  events,
  isObservationEvidence,
  legacyEvidence,
  manifest,
  marketSlug,
  markets,
  observationDate,
  observations,
  occupations,
  topics,
  type LinkedEvent,
  type EventRow,
  type EvidenceRow,
  type ObservationRow,
  type Topic,
} from "./snapshot";

/**
 * Search and record reading for agents (Issue #5). Everything here is read from the data release the pages
 * render, in memory: the same updates, topics, observations and readings a reader can open on the site, and nothing else.
 * No collection store, no raw archive, no reader's submission, no model is reached from here, and a query
 * that finds nothing starts nothing.
 */

export const RECORD_TYPES = ["update", "question", "observation", "evidence", "article"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/**
 * What a search covers when `types` is not given. Evidence readings carry the L0–L5 level scale, which is being
 * retired (Issue #35), so they are returned only when asked for by name.
 */
export const DEFAULT_RECORD_TYPES: readonly RecordType[] = ["update", "question", "observation", "article"];

/** Sent with every evidence reading until the type is removed: one contract minor version after this one. */
export const EVIDENCE_DEPRECATION = {
  since: "contract 1.1.0",
  reason: "The L0–L5 level scale is retired; level, claimed_level and evidence_tier no longer describe a conclusion. Observations replace evidence readings.",
  issue: "https://github.com/feyn-machines/surviagi/issues/35",
} as const;

export const MAX_QUERY = 200;
export const MAX_RESULTS = 20;
export const DEFAULT_RESULTS = 8;
const SNIPPET = 280;
const DETAIL_ROWS = 30;

/** What a text is, so a caller never quotes our summary as the source's words. */
export const CONTENT_KINDS = {
  machine_summary: "Written by our pipeline from the source posts; not the source's own words.",
  post_quote: "Words copied from the original post, possibly shortened.",
  machine_reading: "Deprecated: a level proposed by our judge for one kind of work, from the retired L0–L5 scale; not reviewed by a person.",
  editorial_article: "A public bilingual editorial article. Its status says whether the exact revision is a preview or approved.",
} as const;

const REVIEW = "machine_proposed_unreviewed";

/** The original text of X posts is not in the published data: only their addresses are, and short quotes on topics. */
const ORIGINAL_GAP =
  "The full text of the source posts is not published here. Open the source URLs for the original; X Articles, linked pages and PDFs are not collected.";

/**
 * The four versions every response carries, kept apart (Issue #27): this contract, the ontology schema the
 * records conform to, the method that computed the readings, and the data release the answer came from.
 */
export function versionsInfo() {
  const m = manifest();
  return {
    contract: contract.contract_version,
    ontology: m?.schema_version ?? contract.ontology_version,
    method: m?.method_version ?? null,
    data: dataRelease().releaseId,
  };
}

export function releaseInfo() {
  const m = manifest();
  return { id: dataRelease().releaseId, generated_at: m?.generated_at ?? null, method: m?.method_version ?? null };
}

/** A searched field: its name is what a result's `matched` reports. */
type Field = { name: string; text: string; weight: number };

type Doc = {
  id: string;
  type: RecordType;
  title: string;
  snippet: string;
  /** The Chinese title and snippet, where the record has its own; otherwise a Chinese answer shows the English. */
  zh?: { title: string; snippet: string };
  content: keyof typeof CONTENT_KINDS;
  date: string | null;
  organization: string | null;
  sources: string[];
  path: string;
  markdownPath: string;
  /** Lower-cased fields with weights, searched by substring. */
  fields: Field[];
};

const lower = (text: string | null | undefined) => (text ?? "").normalize("NFKC").toLowerCase();
const clip = (text: string, max = SNIPPET) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join("")}…` : flat;
};

export const evidenceId = (row: Pick<EvidenceRow, "event_id" | "activity_id">) =>
  `evidence:${row.event_id}:${workSlug(row.activity_id)}`;

/** A kind of work is a row on its market's page; the old /work/ address redirects there. */
function workPath(activityId: string): string | null {
  const work = activityById(activityId);
  return work ? `/markets/${marketSlug(work.market_id)}#${activityAnchor(work.activity_id, work.market_id)}` : null;
}

/** The names, in both languages, of the kinds of work an update was linked to and of their markets. */
function workNames(e: LinkedEvent): string {
  const names = new Set<string>();
  for (const link of e.work ?? []) {
    const work = activityById(link.activity_id);
    if (!work) continue;
    for (const name of [work.label_en, work.label_zh_cn, work.market_en, work.market_zh_cn]) if (name) names.add(name);
  }
  return [...names].join(" ");
}

/** An observation as a search document, or null when no page shows it: a result must have a page to cite. */
function observationDoc(row: ObservationRow, updateIds: Set<string>): Doc | null {
  const page = pagesOf(row)[0];
  const path = page ? `${pagePath(page)}#${row.observation_id}` : row.event_id && updateIds.has(row.event_id) ? `/updates/${row.event_id}` : null;
  if (!path) return null;
  const markdownPath = `${path.replace(/#.*$/, "")}/raw.md`;
  const quote = row.facts[0]?.quote ?? row.sources[0]?.quote ?? "";
  const concerns = row.concerns.flatMap((c) => [c.label_en, c.label_zh_cn]).filter(Boolean).join(" ");
  const basis = (["en", "zh-CN"] as const).map((l) => termNameOrRaw("event_basis", row.evidence_type, l)).join(" ");
  return {
    id: row.observation_id,
    type: "observation",
    title: row.task,
    snippet: clip(quote || row.task),
    // The Chinese title is a machine translation; the snippet stays the post's own words.
    zh: row.task_zh_cn ? { title: row.task_zh_cn, snippet: clip(quote || row.task_zh_cn) } : undefined,
    content: quote ? "post_quote" : "machine_summary",
    date: observationDate(row),
    organization: row.actor_name,
    sources: row.sources.map((s) => s.url),
    path,
    markdownPath,
    fields: [
      { name: "task", text: lower(`${row.task} ${row.task_zh_cn ?? ""}`), weight: 3 },
      { name: "concerns", text: lower(concerns), weight: 2 },
      { name: "actor", text: lower([row.actor_name, row.actor_key, row.subject_key === "unspecified" ? null : row.subject_key].filter(Boolean).join(" ")), weight: 2 },
      { name: "facts", text: lower(row.facts.map((f) => `${f.value} ${f.unit ?? ""} ${f.what} ${f.what_zh_cn ?? ""}`).join(" ")), weight: 1 },
      { name: "quotes", text: lower([...row.sources.map((s) => s.quote), ...row.facts.map((f) => f.quote)].join(" ")), weight: 1 },
      { name: "evidence_type", text: lower(basis), weight: 1 },
    ],
  };
}

function buildDocs(): Doc[] {
  const rows = new Map<string, EventRow>(events().map((e) => [e.event_id, e]));
  const docs: Doc[] = [];
  const updates = new Map<string, LinkedEvent>();
  for (const e of linkedEvents()) {
    updates.set(e.event_id, e);
    const more = rows.get(e.event_id);
    docs.push({
      id: e.event_id,
      type: "update",
      title: e.title,
      snippet: clip(e.summary || e.title),
      content: "machine_summary",
      date: e.occurred_at ?? more?.occurred_at ?? null,
      organization: e.org_name,
      sources: e.source_urls ?? [],
      path: `/updates/${e.event_id}`,
      markdownPath: `/updates/${e.event_id}/raw.md`,
      fields: [
        { name: "title", text: lower(e.title), weight: 3 },
        { name: "summary", text: lower(e.summary), weight: 1 },
        { name: "organization", text: lower([e.org_name, more?.org_name_zh_cn, more?.kind].filter(Boolean).join(" ")), weight: 2 },
        { name: "work", text: lower(workNames(e)), weight: 1 },
      ],
    });
  }
  for (const t of topics()) {
    docs.push({
      id: t.topic_id,
      type: "question",
      title: t.question.en,
      snippet: clip(`${t.question["zh-CN"]} · ${t.options.map((o) => `${o.key}) ${o.text.en}`).join(" ")}`),
      zh: t.question["zh-CN"]
        ? { title: t.question["zh-CN"], snippet: clip(`${t.question.en} · ${t.options.map((o) => `${o.key}) ${o.text["zh-CN"] || o.text.en}`).join(" ")}`) }
        : undefined,
      content: "machine_summary",
      date: t.latest_claim_at ?? t.opened_at,
      organization: null,
      sources: [],
      path: `/topics/${t.slug}`,
      markdownPath: `/topics/${t.slug}/raw.md`,
      fields: [
        { name: "question", text: lower(`${t.question.en} ${t.question["zh-CN"]} ${t.object}`), weight: 3 },
        { name: "about", text: lower([t.about?.en, t.about?.["zh-CN"], t.group?.en, t.group?.["zh-CN"]].filter(Boolean).join(" ")), weight: 2 },
        { name: "options", text: lower(t.options.map((o) => `${o.text.en} ${o.text["zh-CN"]}`).join(" ")), weight: 1 },
      ],
    });
  }
  for (const r of legacyEvidence()) {
    const update = updates.get(r.event_id);
    const work = activityById(r.activity_id);
    if (!update || !work) continue;
    docs.push({
      id: evidenceId(r),
      type: "evidence",
      title: `${work.label_en} ← ${update.title}`,
      snippet: clip(`${work.market_en} · ${update.summary || update.title}`),
      content: "machine_reading",
      date: update.occurred_at,
      organization: update.org_name,
      sources: update.source_urls ?? [],
      path: workPath(r.activity_id) ?? `/updates/${r.event_id}`,
      markdownPath: `${(workPath(r.activity_id) ?? `/updates/${r.event_id}`).replace(/#.*$/, "")}/raw.md`,
      fields: [
        { name: "work", text: lower(`${work.label_en} ${work.label_zh_cn ?? ""}`), weight: 3 },
        { name: "market", text: lower(`${work.market_en} ${work.market_zh_cn ?? ""} ${update.title}`), weight: 2 },
        { name: "organization", text: lower(update.org_name), weight: 1 },
      ],
    });
  }
  const updateIds = new Set(updates.keys());
  for (const row of observations()) {
    const doc = observationDoc(row, updateIds);
    if (doc) docs.push(doc);
  }
  return docs;
}

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const isCjk = (term: string) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(term);

/**
 * The Chinese names of the release's occupations, markets and kinds of work, cut at their joining words
 * ("会计师与审计师" gives "会计师" and "审计师"): the words a Chinese query is about, as opposed to how it is asked.
 * Kept as every piece of two characters or more of those words, so a query is looked up piece by piece.
 */
function buildLexicon(): Set<string> {
  const names = [
    ...occupations().map((o) => o.label_zh_cn),
    ...markets().map((m) => m.zh_cn),
    ...activities().flatMap((a) => [a.label_zh_cn, a.market_zh_cn]),
  ];
  const words = new Set<string>();
  for (const name of names) {
    for (const run of (name ?? "").normalize("NFKC").match(CJK_RUN) ?? []) {
      for (const word of run.split(/[与和及或的]/u)) {
        const chars = [...word];
        for (let i = 0; i < chars.length; i += 1) for (let end = i + 2; end <= chars.length; end += 1) words.add(chars.slice(i, end).join(""));
      }
    }
  }
  return words;
}

/** No name piece is looked up longer than this many characters. */
const LONGEST_NAME = 16;

/** An occupation an alternative name can stand for, with the names records carry for it. */
export type AliasTarget = { id: string; label_en: string; label_zh_cn: string | null };

/** An alternative name found in a query, the occupations it stands for, and every text that counts as naming them. */
export type FoundAlias = { term: string; occupations: AliasTarget[]; texts: string[] };

/** A name shared by more occupations than this ("讲师", "engineer") stands for none of them. */
const ALIAS_OCCUPATIONS = 3;
/** Longest alternative name looked up, in words (Latin) or characters (Chinese). */
const ALIAS_WORDS = 6;

/**
 * The release's alternative names of occupations (Occupation.alt_label, Issue #30), folded, each with the
 * occupations it names. "CEO (Chief Executive Officer)" is kept as both of its halves. A Chinese name needs two
 * characters; an English one two words, since one word is either part of the occupation's own name already
 * ("accountant") or a word AI news uses otherwise ("agent", "model", "developer"). A name of more than three
 * occupations is left out.
 */
export function buildAliases(rows: { occupation_id: string; label_en: string; label_zh_cn: string | null; alt_labels_en: string[] | null; alt_labels_zh_cn: string[] | null }[]): Map<string, AliasTarget[]> {
  const index = new Map<string, AliasTarget[]>();
  for (const o of rows) {
    const target = { id: o.occupation_id, label_en: o.label_en, label_zh_cn: o.label_zh_cn };
    for (const label of [...(o.alt_labels_en ?? []), ...(o.alt_labels_zh_cn ?? [])]) {
      for (const part of label.split(/\s*[()（）]\s*/u)) {
        const key = lower(part).replace(/\s+/g, " ").trim();
        if (isCjk(key) ? [...key].length < 2 : !key.includes(" ")) continue;
        const listed = index.get(key) ?? [];
        if (!listed.some((x) => x.id === target.id)) index.set(key, [...listed, target]);
      }
    }
  }
  for (const [key, targets] of index) if (targets.length > ALIAS_OCCUPATIONS) index.delete(key);
  return index;
}

/**
 * The alternative names in a query, longest first from the left: "码农" in "码农会被取代吗", "software engineer" in
 * "will AI replace software engineers". An English name matches whole words, with a plural "s" allowed. Each
 * stands for its occupations: a record that names any of them, in either language, holds the term
 * (rule:alternative-names-find-not-define: the record is found by the alias, and still named by its own name).
 */
export function findAliases(query: string, index: Map<string, AliasTarget[]>): FoundAlias[] {
  const found = new Map<string, AliasTarget[]>();
  const text = lower(query);
  for (const run of text.match(CJK_RUN) ?? []) {
    const chars = [...run];
    let i = 0;
    while (i < chars.length - 1) {
      let end = Math.min(chars.length, i + LONGEST_NAME);
      while (end >= i + 2 && !index.has(chars.slice(i, end).join(""))) end -= 1;
      if (end >= i + 2) {
        const key = chars.slice(i, end).join("");
        found.set(key, index.get(key)!);
        i = end;
      } else i += 1;
    }
  }
  const words = text.match(/[a-z0-9][a-z0-9.+#&'-]*/g) ?? [];
  let i = 0;
  while (i < words.length) {
    let hit = 0;
    for (let n = Math.min(ALIAS_WORDS, words.length - i); n >= 1 && !hit; n -= 1) {
      const phrase = words.slice(i, i + n).join(" ");
      const key = index.has(phrase) ? phrase : phrase.endsWith("s") && index.has(phrase.slice(0, -1)) ? phrase.slice(0, -1) : null;
      if (key) {
        found.set(key, index.get(key)!);
        hit = n;
      }
    }
    i += hit || 1;
  }
  return [...found].map(([term, occupations]) => ({
    term,
    occupations,
    texts: [...new Set([term, ...occupations.flatMap((o) => [lower(o.label_en), lower(o.label_zh_cn)]).filter(Boolean)])],
  }));
}

let cached: { key: string; docs: Doc[]; texts: string[]; lexicon: Set<string>; aliases: Map<string, AliasTarget[]> } | null = null;

/** The documents of the loaded release, built once per release, with each one's fields joined for counting terms. */
function corpus() {
  const release = dataRelease();
  const key = `${release.releaseId}|${release.loadedAt}`;
  if (cached?.key !== key) {
    const built = buildDocs();
    cached = { key, docs: built, texts: built.map((d) => d.fields.map((f) => f.text).join("\n")), lexicon: buildLexicon(), aliases: buildAliases(occupations()) };
  }
  return cached;
}

/**
 * The longest pieces of the query's Chinese that are part of a name in the lexicon, read left to right:
 * "程序员" and nothing else in "程序员会被取代吗" (in "计算机程序员"). Two characters at least.
 */
export function namedTerms(query: string, lexicon: Set<string>): string[] {
  const out: string[] = [];
  for (const run of lower(query).match(CJK_RUN) ?? []) {
    const chars = [...run];
    let i = 0;
    while (i < chars.length - 1) {
      let found = 0;
      for (let end = Math.min(chars.length, i + LONGEST_NAME); end >= i + 2 && !found; end -= 1) {
        if (lexicon.has(chars.slice(i, end).join(""))) found = end - i;
      }
      if (found) {
        out.push(chars.slice(i, i + found).join(""));
        i += found;
      } else i += 1;
    }
  }
  return [...new Set(out)];
}

/**
 * How much a term says, from how many records of the release contain it: about 1 for a term in one record of a
 * hundred, less for a term most records contain ("会被", "取代" in a question), more for a rare one, between 0.25
 * and 1.5. A term no record contains is 0.
 */
function termWeights(words: string[], texts: string[]): number[] {
  const n = Math.max(1, texts.length);
  return words.map((word) => {
    let df = 0;
    for (const text of texts) if (text.includes(word)) df += 1;
    return df === 0 ? 0 : Math.min(1.5, Math.max(0.25, Math.log(n / df) / Math.log(100)));
  });
}

const STOP = new Set(["a", "an", "and", "the", "of", "to", "in", "on", "for", "is", "are", "be", "by", "with", "or", "at", "as", "it", "its", "do", "does", "will", "what", "how", "which", "who"]);

/** Latin words and numbers whole; Chinese, Japanese and Korean runs as overlapping pairs (one character alone stays one). */
export function terms(query: string): string[] {
  const out = new Set<string>();
  for (const word of lower(query).match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? []) {
    for (const part of word.split(/(\p{Script=Han}+|\p{Script=Hiragana}+|\p{Script=Katakana}+|\p{Script=Hangul}+)/u)) {
      if (!part) continue;
      if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(part)) {
        const chars = [...part];
        if (chars.length === 1) out.add(part);
        for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
      } else {
        const clean = part.replace(/[.+#-]+$/, "");
        if (clean && !STOP.has(clean)) out.add(clean);
      }
    }
  }
  return [...out].slice(0, 24);
}

export type SearchInput = {
  query: string;
  limit?: number;
  types?: RecordType[];
  from?: string | null;
  to?: string | null;
  language?: Language;
};

export type SearchResult = {
  id: string;
  type: RecordType;
  title: string;
  snippet: string;
  content: keyof typeof CONTENT_KINDS;
  review: typeof REVIEW;
  date: string | null;
  organization: string | null;
  url: string;
  markdown_url: string;
  sources: string[];
  /** The language `title` and `snippet` are written in: Chinese only where the record has its own Chinese text. */
  title_language: Language;
  /** Why it matched: each field that held query terms, with those terms, strongest field first. */
  matched: { field: string; terms: string[] }[];
};

export type RankedSearchResult = { result: SearchResult; score: number };

/**
 * Ranks the release's records by the query terms they contain, each weighted by its field and by how rare it is
 * in the release, with a bonus for the whole query as typed. A record must hold at least half of the terms, or
 * half of their weight: "程序员" in "程序员会被取代吗" outweighs "会被" and "代吗", which many questions share. Ties go to the
 * newer record. Dates filter on the record's own date (an update's `occurred_at`, a question's latest claim, an
 * observation's announcement), and an undated record passes no date filter. A query of one or two terms needs all
 * of them: "coding agent" is not every record about agents. A pair of Chinese characters no record contains is
 * an artefact of cutting the query into pairs ("代吗" in "会被取代吗") and is not required. When the Chinese of
 * the query names an occupation, market or kind of work, a record must contain one of those names: "程序员会被取代吗"
 * is about programmers, not every question that asks "会被取代吗".
 *
 * Records carry names in both languages where the release has them (the kinds of work an update was linked to,
 * an observation's occupations, markets and tasks, a question's subject), so a Chinese query finds English
 * records through them; `matched` says which field it was.
 */
export function rankedSearch(input: SearchInput): { query: string; total: number; results: RankedSearchResult[]; aliases: { term: string; occupations: AliasTarget[] }[]; release: ReturnType<typeof releaseInfo>; content_kinds: typeof CONTENT_KINDS } {
  const { docs, texts, lexicon, aliases: aliasIndex } = corpus();
  // An alternative name stands for its occupations' own names; the pieces of the query inside it are not asked again.
  const aliases = findAliases(input.query, aliasIndex).filter((a) => texts.some((text) => a.texts.some((t) => text.includes(t))));
  const inAlias = (word: string) => aliases.some((a) => a.term.includes(word));
  const named = namedTerms(input.query, lexicon).filter((word) => texts.some((text) => text.includes(word)));
  const all = [...new Set([...terms(input.query), ...named])].filter((word) => !inAlias(word));
  const weights = termWeights(all, texts);
  const words = all.filter((word, i) => weights[i] > 0 || !isCjk(word));
  const rarity = words.map((word) => weights[all.indexOf(word)]);
  const aliasRarity = aliases.map((a) => {
    const df = texts.filter((text) => a.texts.some((t) => text.includes(t))).length;
    return Math.min(1.5, Math.max(0.25, Math.log(Math.max(1, texts.length) / df) / Math.log(100)));
  });
  const naming = [...named.filter((word) => !inAlias(word)).map((word) => [word]), ...aliases.map((a) => a.texts)];
  const phrase = lower(input.query).trim();
  const limit = Math.min(MAX_RESULTS, Math.max(1, input.limit ?? DEFAULT_RESULTS));
  const types = new Set<RecordType>(input.types ?? DEFAULT_RECORD_TYPES);
  const language = input.language ?? "en";
  const total = [...rarity, ...aliasRarity].reduce((sum, r) => sum + r, 0);
  const asked = words.length + aliases.length;
  // A query that names an occupation is about it: a record that names it qualifies, and the way the question is
  // asked ("还有前途吗", "会被取代吗") only ranks.
  const enough = (count: number, held: number) =>
    count > 0 && (naming.length > 0 || (asked <= 2 ? count === asked : count >= Math.ceil(asked / 2) || held >= total / 2));
  const scored: { doc: Doc; score: number; matched: Map<string, string[]> }[] = [];
  for (const doc of asked === 0 ? [] : docs) {
    if (!types.has(doc.type)) continue;
    if (input.from && (!doc.date || doc.date.slice(0, 10) < input.from)) continue;
    if (input.to && (!doc.date || doc.date.slice(0, 10) > input.to)) continue;
    let count = 0;
    let held = 0;
    let score = 0;
    const matched = new Map<string, string[]>();
    words.forEach((word, i) => {
      let best: Field | null = null;
      for (const field of doc.fields) if (field.weight > (best?.weight ?? 0) && field.text.includes(word)) best = field;
      if (!best) return;
      count += 1;
      held += rarity[i];
      score += best.weight * rarity[i];
      matched.set(best.name, [...(matched.get(best.name) ?? []), word]);
    });
    aliases.forEach((alias, i) => {
      let best: Field | null = null;
      for (const field of doc.fields) if (field.weight > (best?.weight ?? 0) && alias.texts.some((t) => field.text.includes(t))) best = field;
      if (!best) return;
      count += 1;
      held += aliasRarity[i];
      score += best.weight * aliasRarity[i];
      matched.set(best.name, [...(matched.get(best.name) ?? []), alias.term]);
    });
    if (!enough(count, held)) continue;
    if (naming.length && !naming.some((any) => any.some((word) => doc.fields.some((field) => field.text.includes(word))))) continue;
    if (phrase.length > 2 && doc.fields.some((field) => field.text.includes(phrase))) score += 5;
    scored.push({ doc, score: score + count / Math.max(1, words.length), matched });
  }
  scored.sort((a, b) => b.score - a.score || (b.doc.date ?? "").localeCompare(a.doc.date ?? "") || a.doc.id.localeCompare(b.doc.id));
  return {
    query: input.query,
    total: scored.length,
    results: scored.slice(0, limit).map(({ doc, score, matched }) => {
      const zh = language === "zh-CN" ? doc.zh : undefined;
      const order = new Map(doc.fields.map((f, i) => [f.name, i]));
      return {
        score,
        result: {
          id: doc.id,
          type: doc.type,
          title: zh?.title ?? doc.title,
          snippet: zh?.snippet ?? doc.snippet,
          content: doc.content,
          review: REVIEW,
          date: doc.date,
          organization: doc.organization,
          url: absoluteUrl(language, doc.path),
          markdown_url: absoluteUrl(language, doc.markdownPath),
          sources: doc.sources,
          title_language: zh ? "zh-CN" : "en",
          matched: [...matched.entries()]
            .sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
            .map(([field, found]) => ({ field, terms: found })),
        },
      };
    }),
    aliases: aliases.map(({ term, occupations }) => ({ term, occupations })),
    release: releaseInfo(),
    content_kinds: CONTENT_KINDS,
  };
}

export function search(input: SearchInput) {
  const found = rankedSearch({ ...input, types: input.types?.length ? input.types : undefined });
  return { ...found, results: found.results.map(({ result }) => result) };
}

const ID_UPDATE = /^ev-[0-9a-f]{40}$/;
const ID_EVIDENCE = /^evidence:(ev-[0-9a-f]{40}):([a-z0-9-]{1,200})$/;
const ID_QUESTION = /^topic:[a-z_]+:[a-z0-9-]*:[0-9a-f]{8}$/;

/** True for the shape of an id `search` hands out; says nothing about whether the release holds it. */
export function isRecordId(id: string): boolean {
  return ID_UPDATE.test(id) || ID_EVIDENCE.test(id) || ID_QUESTION.test(id) || OBSERVATION_ID.test(id);
}

function updateRecord(e: LinkedEvent, language: Language) {
  const more = events().find((row) => row.event_id === e.event_id);
  const readings = legacyEvidence().filter((r) => r.event_id === e.event_id);
  return {
    id: e.event_id,
    type: "update" as const,
    url: absoluteUrl(language, `/updates/${e.event_id}`),
    markdown_url: absoluteUrl(language, `/updates/${e.event_id}/raw.md`),
    title: e.title,
    summary: e.summary,
    summary_content: "machine_summary" as const,
    review: REVIEW,
    kind: more?.kind ?? null,
    organization: e.org_name,
    organization_zh_cn: more?.org_name_zh_cn ?? null,
    occurred_at: e.occurred_at ?? more?.occurred_at ?? null,
    sources: (e.source_urls ?? []).map((url) => ({ url, kind: "original_post" as const })),
    original_text: { available: false, note: ORIGINAL_GAP },
    readings_total: readings.length,
    readings: readings.slice(0, DETAIL_ROWS).map((r) => readingSummary(r, language)),
  };
}

function readingSummary(r: EvidenceRow, language: Language) {
  const work = activityById(r.activity_id);
  return {
    id: evidenceId(r),
    work: work ? { label: work.label_en, label_zh_cn: work.label_zh_cn, market: work.market_en } : null,
    work_url: workPath(r.activity_id) ? absoluteUrl(language, workPath(r.activity_id)!) : null,
    level: r.level,
    claimed_level: r.observed_level,
    evidence_tier: r.evidence_tier,
    status: r.status,
    deprecated: EVIDENCE_DEPRECATION,
  };
}

function questionRecord(t: Topic, language: Language) {
  return {
    id: t.topic_id,
    type: "question" as const,
    url: absoluteUrl(language, `/topics/${t.slug}`),
    markdown_url: absoluteUrl(language, `/topics/${t.slug}/raw.md`),
    question: t.question,
    about: t.about,
    state: t.state,
    origin: t.origin,
    opened_at: t.opened_at,
    latest_claim_at: t.latest_claim_at,
    note: "A question carries no answer of its own: options list who argued them in the posts collected, not who is right.",
    review: REVIEW,
    options: t.options.map((o) => ({ key: o.key, text: o.text, accounts: o.accounts, supports: o.supports, contradicts: o.contradicts })),
    claims_total: t.claims.length,
    claims: t.claims.slice(0, DETAIL_ROWS).map((c) => ({
      option: c.option,
      handle: c.handle,
      url: c.url,
      published_at: c.published_at,
      says: c.says,
      says_content: "machine_summary" as const,
      quote: c.quote,
      quote_content: c.quote ? ("post_quote" as const) : null,
    })),
    evidence_total: t.evidence.length,
    // Observations since contract 1.8.0 (read one by its id); updates in a release before.
    evidence: t.evidence.slice(0, DETAIL_ROWS).map((v) =>
      isObservationEvidence(v)
        ? { observation_id: v.observation_id, option: v.option, sign: v.sign, confidence: v.confidence }
        : { update_id: v.event_id, option: v.option, sign: v.sign, confidence: v.confidence, title: v.title, occurred_at: v.occurred_at, source_url: v.source_url }),
    original_text: { available: false, note: ORIGINAL_GAP },
  };
}

function evidenceRecord(r: EvidenceRow, e: LinkedEvent, language: Language) {
  const work = activityById(r.activity_id);
  const workUrl = workPath(r.activity_id) ? absoluteUrl(language, workPath(r.activity_id)!) : null;
  return {
    id: evidenceId(r),
    type: "evidence" as const,
    /** The page that shows this reading: its work's row on the market page, or the update's when the work is unknown. */
    url: workUrl ?? absoluteUrl(language, `/updates/${e.event_id}`),
    content: "machine_reading" as const,
    review: REVIEW,
    deprecated: EVIDENCE_DEPRECATION,
    status: r.status,
    work: work ? { label: work.label_en, label_zh_cn: work.label_zh_cn, market: work.market_en, market_zh_cn: work.market_zh_cn } : null,
    work_url: workUrl,
    level: r.level,
    claimed_level: r.observed_level,
    level_note: "`level` is what the evidence tier allows; `claimed_level` is what the judge proposed before that cap.",
    evidence_tier: r.evidence_tier,
    confidence: r.confidence,
    rationale: r.rationale,
    update: { id: e.event_id, title: e.title, url: absoluteUrl(language, `/updates/${e.event_id}`), occurred_at: e.occurred_at, organization: e.org_name },
    sources: (e.source_urls ?? []).map((url) => ({ url, kind: "original_post" as const })),
    confirmations: (r.confirmations ?? []).slice(0, DETAIL_ROWS).map((c) => ({
      handle: c.handle, url: c.url, posted_at: c.posted_at, post_nature: c.post_nature, evidence_tier: c.evidence_tier, level: c.level,
    })),
    original_text: { available: false, note: ORIGINAL_GAP },
  };
}

/** One record of the loaded release by the id `search` gave, or null when the release does not hold it. */
export function record(id: string, language: Language = "en") {
  const release = releaseInfo();
  const versions = versionsInfo();
  if (ID_UPDATE.test(id)) {
    const e = linkedEvents().find((row) => row.event_id === id);
    return e ? { ...updateRecord(e, language), release, versions } : null;
  }
  if (ID_QUESTION.test(id)) {
    const t = topics().find((row) => row.topic_id === id);
    return t ? { ...questionRecord(t, language), release, versions } : null;
  }
  if (OBSERVATION_ID.test(id)) {
    const o = observationRecord(id, language);
    return o ? { ...o, release, versions } : null;
  }
  const parts = ID_EVIDENCE.exec(id);
  if (parts) {
    const e = linkedEvents().find((row) => row.event_id === parts[1]);
    const r = legacyEvidence().find((row) => row.event_id === parts[1] && workSlug(row.activity_id) === parts[2]);
    return e && r ? { ...evidenceRecord(r, e, language), release, versions } : null;
  }
  return null;
}

/** The published topic whose question is this one, folded the same way submissions are compared. */
export function publishedQuestion(fold: (text: string) => string, question: string): Topic | undefined {
  const key = fold(question);
  return topics().find((t) => fold(t.question.en) === key || fold(t.question["zh-CN"]) === key);
}
