import { termDefinition, termNameOrRaw } from "@/components/ontology-labels";
import { bilingual, type Language } from "@/lib/i18n";
import { colon } from "@/lib/markdown-copy";
import { plural } from "@/lib/plural";
import { SITE_URL, absoluteUrl, datasetLd, faqLd } from "@/lib/seo";
import {
  EVIDENCE_ORDER,
  byStrength,
  coverage,
  manifest,
  observationDate,
  observationStats,
  observationsPublished,
  sources,
  type EvidenceType,
  type ObservationRow,
  type ObservationStats,
} from "@/lib/snapshot";

/**
 * The evidence ledger of a market or an occupation page (Issue #32): the
 * observations mapped to it, counted by what each rests on, then the strongest
 * ones and the ones pointing the other way, each with its figures and the
 * words it was read from.
 *
 * The page and its Markdown copy both build from `ledger`, so they say the
 * same numbers. Nothing here weighs one type against another: the counts sit
 * side by side and the order of the list is the only ranking.
 */

export const ledgerCopy = bilingual({
  en: {
    title: "What the evidence shows",
    lead: "Observations read from collected posts, counted by what each one rests on.",
    answer: "As of {date}, {n} {n|observation bears|observations bear} on {name}: {types}.",
    against: "{n} of them {n|says|say} a person is still needed or the AI fell short.",
    againstNone: "None of them says a person is still needed.",
    recent: "{d30} said in the 30 days before the data date, {d90} in the 90 days.",
    undated: "{n} {n|carries|carry} no date.",
    none: "No observation has been mapped here yet.",
    noneWhy: "That describes what was collected and read, not the work itself.",
    notPublished: "This data release does not carry observations yet.",
    strongest: "Strongest evidence",
    strongestLead: "Production use and independent measurement first, vendor claims last.",
    otherWay: "Evidence the other way",
    otherWayLead: "Observations saying a person is still needed, or that the AI did not do it.",
    all: "The other {n} {n|observation|observations}",
    more: "{n} more are in the data release and the Agent interface.",
    by: "{actor} ({role})",
    unknownActor: "unnamed",
    source: "source",
    original: "original wording",
    machine: "Read by a model; no person has checked it.",
    conditions: "Conditions",
    scale: "Scale",
    perType: "{n|observation|observations}",
    acrossTitle: "What the evidence shows across {kind}",
    across: "As of {date}, {n} {n|observation is|observations are} mapped to {m} of the {total} {kind}: {types}.",
    acrossNone: "As of {date}, no observation is mapped to any of the {total} {kind}.",
    acrossWhy: "An observation that bears on several is counted once here and once on each of their pages.",
    markets: "markets",
    occupations: "occupations",
    whenTitle: "When it was said",
    whenLead: "Observations by the month they were said in public, with how many point the other way.",
    undatedMonth: "no date",
    againstShort: "{n} the other way",
    whoTitle: "Who says it",
    whoLead: "The role of the one acting in each observation, then the names that occur most.",
    actorCount: "{n} {n|observation|observations}",
    othersActors: "{n} other {n|name|names} with fewer.",
    coverageTitle: "What was read, and where it leans",
    collected: "Read from public posts on X by {accounts} watched accounts ({roles}) and from X searches; updates collected {first} to {last}.",
    vendorShare: "{share}% of these observations rest on what the maker itself shows or says.",
    practitionerShare: "{share}% come from individual practitioners; {n} name an organisation that adopted it.",
    leans: "English posts and AI companies' own accounts dominate what is read, so the counts lean toward what vendors announce.",
    absence: "A market or occupation with no observation has not been read about; that is not evidence that nothing changed.",
  },
  "zh-CN": {
    title: "证据怎么说",
    lead: "从采集到的帖子里读出的观察，按每条依据的是什么分类计数。",
    answer: "截至 {date}，有 {n} 条观察涉及{name}：{types}。",
    against: "其中 {n} 条说仍需要人，或 AI 没做到。",
    againstNone: "其中没有一条说仍需要人。",
    recent: "数据日期前 30 天内说的有 {d30} 条，90 天内 {d90} 条。",
    undated: "{n} 条没有日期。",
    none: "还没有观察映射到这里。",
    noneWhy: "这说的是采集和读到了什么，不是这份工作本身。",
    notPublished: "这个数据版本还没有发布观察。",
    strongest: "最有分量的证据",
    strongestLead: "生产使用和他人测量在前，出品方自述在后。",
    otherWay: "反方向的证据",
    otherWayLead: "说仍需要人，或者 AI 没做到的观察。",
    all: "其余 {n} 条观察",
    more: "另有 {n} 条在数据版本和 Agent 接口里。",
    by: "{actor}（{role}）",
    unknownActor: "未具名",
    source: "原文",
    original: "原文措辞",
    machine: "由模型读出，没有人核对过。",
    conditions: "条件",
    scale: "规模",
    perType: "条",
    acrossTitle: "证据怎么说：全部{kind}",
    across: "截至 {date}，有 {n} 条观察映射到 {total} 个{kind}中的 {m} 个：{types}。",
    acrossNone: "截至 {date}，{total} 个{kind}里还没有一个映射到观察。",
    acrossWhy: "一条观察涉及几个时，这里只算一次，在它们各自的页面上各算一次。",
    markets: "赛道",
    occupations: "职业",
    whenTitle: "什么时候说的",
    whenLead: "按公开说出的月份计数，并列出其中反方向的条数。",
    undatedMonth: "无日期",
    againstShort: "反方向 {n}",
    whoTitle: "谁说的",
    whoLead: "每条观察里行动一方的身份，以及出现最多的名字。",
    actorCount: "{n} 条",
    othersActors: "另有 {n} 个名字，条数更少。",
    coverageTitle: "读了什么，偏向哪里",
    collected: "读自 {accounts} 个关注账号（{roles}）在 X 上的公开帖子及 X 搜索；更新采集于 {first} 至 {last}。",
    vendorShare: "这些观察中 {share}% 依据的是出品方自己的演示或说法。",
    practitionerShare: "{share}% 来自从业者个人；{n} 条点名了采用它的机构。",
    leans: "读到的以英文帖子和 AI 公司自己的账号为主，所以计数偏向厂商宣布的内容。",
    absence: "没有观察的赛道或职业只是还没读到相关内容，不说明什么都没变。",
  },
});

/** How many observations a page lists before folding the rest away, and how many it folds. */
const SHOWN = 6;
const FOLDED = 60;

export type Ledger =
  | { state: "unpublished" }
  | { state: "none" }
  | {
      state: "some";
      stats: ObservationStats;
      /** One quotable sentence and the lines under it. */
      answer: string;
      notes: string[];
      strongest: ObservationRow[];
      otherWay: ObservationRow[];
      rest: ObservationRow[];
      /** Mapped here but past what a page lists. */
      unlisted: number;
    };

export const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), plural(template, values));

export function typeName(type: EvidenceType, language: Language): string {
  return termNameOrRaw("event_basis", type, language);
}

export function typeMeaning(type: EvidenceType, language: Language): string | null {
  return termDefinition("event_basis", type, language)?.text ?? null;
}

/** "1 production use, 1 measurement" / "生产使用 1 条、测量 1 条": the types that occur, strongest first. */
export function typesLine(stats: Pick<ObservationStats, "byType">, language: Language): string {
  return EVIDENCE_ORDER.filter((t) => stats.byType[t] > 0)
    .map((t) => (language === "zh-CN" ? `${typeName(t, language)} ${stats.byType[t]} 条` : `${stats.byType[t]} ${typeName(t, language).toLowerCase()}`))
    .join(language === "zh-CN" ? "、" : ", ");
}

/** The lines under the answer: how many point the other way, how recent they are, how many carry no date. */
function notesOf(stats: ObservationStats, language: Language): string[] {
  const c = ledgerCopy[language];
  return [
    stats.against > 0 ? fill(c.against, { n: stats.against }) : c.againstNone,
    fill(c.recent, { d30: stats.last30, d90: stats.last90 }),
    ...(stats.undated > 0 ? [fill(c.undated, { n: stats.undated })] : []),
  ];
}

export function ledger(rows: ObservationRow[], name: string, language: Language): Ledger {
  if (!observationsPublished()) return { state: "unpublished" };
  if (rows.length === 0) return { state: "none" };
  const c = ledgerCopy[language];
  const date = manifest()?.generated_at ?? null;
  const stats = observationStats(rows, date);
  const sorted = [...rows].sort(byStrength);
  const otherWay = sorted.filter((r) => r.direction === "human_still_needed");
  const forward = sorted.filter((r) => r.direction !== "human_still_needed");
  const strongest = forward.slice(0, SHOWN);
  const shownOther = otherWay.slice(0, SHOWN);
  const remaining = [...forward.slice(SHOWN), ...otherWay.slice(SHOWN)].sort(byStrength);
  return {
    state: "some",
    stats,
    answer: fill(c.answer, { date: date?.slice(0, 10) ?? "", n: stats.total, name, types: typesLine(stats, language) }),
    notes: notesOf(stats, language),
    strongest,
    otherWay: shownOther,
    rest: remaining.slice(0, FOLDED),
    unlisted: Math.max(0, remaining.length - FOLDED),
  };
}

export type Month = { month: string | null; total: number; against: number; byType: Record<EvidenceType, number> };
export type Actor = { key: string; name: string; role: ObservationRow["actor_role"]; total: number };
export const ACTOR_ROLES: ObservationRow["actor_role"][] = ["adopter", "practitioner", "evaluator", "researcher", "maker"];

export type Overview =
  | { state: "unpublished"; title: string }
  | {
      state: "some";
      title: string;
      stats: ObservationStats;
      answer: string;
      notes: string[];
      /** Newest month first, every month between the first and the last, then the undated. */
      months: Month[];
      roles: Record<ObservationRow["actor_role"], number>;
      actors: Actor[];
      /** Names past the ones listed. */
      otherActors: number;
      coverage: string[];
    };

/** How many months and names the list pages show. */
const MONTHS = 12;
const ACTORS = 10;

const byTypeOf = (rows: ObservationRow[]) => observationStats(rows, null).byType;

/** Months from the newest back to the oldest dated one (at most `MONTHS`), empty ones included, then the undated. */
function monthsOf(rows: ObservationRow[]): Month[] {
  const dated = new Map<string, ObservationRow[]>();
  const undated: ObservationRow[] = [];
  for (const row of rows) {
    const day = observationDate(row);
    if (!day) undated.push(row);
    else dated.set(day.slice(0, 7), [...(dated.get(day.slice(0, 7)) ?? []), row]);
  }
  const keys = [...dated.keys()].sort();
  const out: Month[] = [];
  if (keys.length > 0) {
    let [y, m] = keys[keys.length - 1].split("-").map(Number);
    const first = keys[0];
    while (out.length < MONTHS) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      const group = dated.get(key) ?? [];
      out.push({ month: key, total: group.length, against: group.filter((r) => r.direction === "human_still_needed").length, byType: byTypeOf(group) });
      if (key <= first) break;
      [y, m] = m === 1 ? [y - 1, 12] : [y, m - 1];
    }
  }
  if (undated.length > 0) {
    out.push({ month: null, total: undated.length, against: undated.filter((r) => r.direction === "human_still_needed").length, byType: byTypeOf(undated) });
  }
  return out;
}

function actorsOf(rows: ObservationRow[], language: Language): Actor[] {
  const c = ledgerCopy[language];
  const by = new Map<string, Actor>();
  for (const row of rows) {
    const actor = by.get(row.actor_key) ?? { key: row.actor_key, name: row.actor_name ?? c.unknownActor, role: row.actor_role, total: 0 };
    actor.total += 1;
    by.set(row.actor_key, actor);
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/**
 * What the counts stand on: who was read, over which days, and the lean that
 * follows. The shares are of the observations above, not of any market.
 */
function coverageOf(rows: ObservationRow[], language: Language): string[] {
  const c = ledgerCopy[language];
  const watched = sources();
  const roleCounts = new Map<string, number>();
  for (const s of watched) roleCounts.set(s.panel_role, (roleCounts.get(s.panel_role) ?? 0) + 1);
  const roles = [...roleCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([role, n]) => (language === "zh-CN" ? `${termNameOrRaw("panel_role", role, language)} ${n}` : `${n} ${termNameOrRaw("panel_role", role, language).toLowerCase()}`))
    .join(language === "zh-CN" ? "、" : ", ");
  const window = coverage()?.collection_window;
  const lines: string[] = [];
  if (watched.length > 0 && window?.first && window.last) {
    lines.push(fill(c.collected, { accounts: watched.length, roles, first: window.first.slice(0, 10), last: window.last.slice(0, 10) }));
  }
  if (rows.length > 0) {
    const vendor = rows.filter((r) => r.evidence_type === "vendor_claim" || r.evidence_type === "demonstration").length;
    const practitioners = rows.filter((r) => r.actor_role === "practitioner").length;
    const adopters = rows.filter((r) => r.actor_role === "adopter").length;
    lines.push(fill(c.vendorShare, { share: percent(vendor, rows.length) }));
    lines.push(fill(c.practitionerShare, { share: percent(practitioners, rows.length), n: adopters }));
  }
  lines.push(c.leans, c.absence);
  return lines;
}

/**
 * The same counts over a whole list page (Issue #32): every observation mapped
 * to at least one market, or one occupation, once each, and how many of them
 * have any; then when they were said, who says them, and what was read. `byPage`
 * holds each page's own rows, so the per-row column and this total come from
 * the same mapping.
 */
export function overview(byPage: ObservationRow[][], kind: "markets" | "occupations", language: Language): Overview {
  const c = ledgerCopy[language];
  const title = fill(c.acrossTitle, { kind: c[kind] });
  if (!observationsPublished()) return { state: "unpublished", title };
  const date = manifest()?.generated_at ?? null;
  const rows = [...new Map(byPage.flat().map((row) => [row.observation_id, row])).values()];
  const stats = observationStats(rows, date);
  const values = { date: date?.slice(0, 10) ?? "", n: stats.total, m: byPage.filter((p) => p.length > 0).length, total: byPage.length, kind: c[kind] };
  const roles = Object.fromEntries(ACTOR_ROLES.map((r) => [r, rows.filter((row) => row.actor_role === r).length])) as Record<ObservationRow["actor_role"], number>;
  const actors = actorsOf(rows, language);
  const common = { state: "some" as const, title, stats, months: monthsOf(rows), roles, actors: actors.slice(0, ACTORS), otherActors: Math.max(0, actors.length - ACTORS), coverage: coverageOf(rows, language) };
  if (rows.length === 0) return { ...common, answer: fill(c.acrossNone, values), notes: [] };
  return {
    ...common,
    answer: fill(c.across, { ...values, types: typesLine(stats, language) }),
    notes: [...notesOf(stats, language), c.acrossWhy],
  };
}

/** A month's counts as one short line: "1 production use, 2 own use" / "生产使用 1 条、亲自使用 2 条". */
export function monthTypes(month: Month, language: Language): string {
  return typesLine(month, language);
}

/** One figure as a reader reads it: "48 % — Azure revenue growth". */
export function figure(fact: ObservationRow["facts"][number]): string {
  return `${fact.value}${fact.unit ? ` ${fact.unit}` : ""} — ${fact.what}`;
}

export function actorLine(row: ObservationRow, language: Language): string {
  const c = ledgerCopy[language];
  return fill(c.by, {
    actor: row.actor_name ?? c.unknownActor,
    role: termNameOrRaw("observation_actor_role", row.actor_role, language),
  });
}

const escape = (text: string) => text.replace(/([[\]])/g, "\\$1");

export function observationMarkdown(row: ObservationRow, language: Language): string[] {
  const c = ledgerCopy[language];
  const sep = colon(language);
  const head = [
    observationDate(row) ?? "—",
    typeName(row.evidence_type, language),
    termNameOrRaw("event_result", row.outcome, language),
    termNameOrRaw("observation_direction", row.direction, language),
  ].join(" · ");
  const lines = [`- ${head}${sep}${row.task} — ${actorLine(row, language)} \`${row.observation_id}\``];
  for (const f of row.facts) lines.push(`  - ${figure(f)}: “${f.quote}”`);
  if (row.scale) lines.push(`  - ${c.scale}${sep}${row.scale}`);
  if (row.conditions) lines.push(`  - ${c.conditions}${sep}${row.conditions}`);
  for (const s of row.sources) lines.push(`  - [${c.source}](${s.url}): “${escape(s.quote)}”`);
  return lines;
}

/** The ledger as Markdown lines, under a heading of the page's level two. */
export function ledgerMarkdown(view: Ledger, language: Language): string[] {
  const c = ledgerCopy[language];
  const sep = colon(language);
  const body = [`## ${c.title}`, "", c.lead, ""];
  if (view.state === "unpublished") return [...body, c.notPublished, ""];
  if (view.state === "none") return [...body, `${c.none} ${c.noneWhy}`, ""];
  body.push(`> ${view.answer}`, "", ...view.notes.map((n) => `- ${n}`), "");
  for (const t of EVIDENCE_ORDER) body.push(`- ${typeName(t, language)}${sep}${view.stats.byType[t]}`);
  body.push("", c.machine, "", `### ${c.strongest}`, "");
  for (const row of view.strongest) body.push(...observationMarkdown(row, language));
  if (view.otherWay.length > 0) {
    body.push("", `### ${c.otherWay}`, "");
    for (const row of view.otherWay) body.push(...observationMarkdown(row, language));
  }
  if (view.rest.length > 0) {
    body.push("", `### ${fill(c.all, { n: view.rest.length })}`, "");
    for (const row of view.rest) body.push(...observationMarkdown(row, language));
  }
  if (view.unlisted > 0) body.push("", fill(c.more, { n: view.unlisted }));
  body.push("");
  return body;
}

/**
 * The question a market or an occupation page answers, as its title (Issue
 * #32): the words a person searches with, the subject's name inside them.
 */
export const questionCopy = bilingual({
  en: {
    market: "Will AI change {name}? The evidence so far",
    occupation: "Will AI replace {name}? The evidence so far",
    howCounted: "What does each count rest on?",
  },
  "zh-CN": {
    market: "AI 会改变{name}这门生意吗？现在的证据",
    occupation: "AI 会取代{name}吗？现在的证据",
    howCounted: "每一类计数依据的是什么？",
  },
});

/**
 * "Will AI replace credit analysts?": an English name set mid-sentence drops
 * the capitals of its ordinary words and keeps acronyms and languages.
 */
function inSentence(name: string): string {
  return name.replace(/\b([A-Z])([a-z]+)\b/g, (word, first: string, rest: string) =>
    /^(English|Spanish|French|German|Chinese|American)$/.test(word) ? word : first.toLowerCase() + rest,
  );
}

export function pageQuestion(kind: "market" | "occupation", name: string, language: Language): string {
  return fill(questionCopy[language][kind], { name: language === "en" ? inSentence(name) : name });
}

/**
 * The questions a market or an occupation page answers and the answers it
 * shows, word for word, for its FAQ structured data: the page question with
 * the ledger's sentence and the lines under it, then what each count rests on.
 * `sentence` is the page's own dated line, used when no observation is mapped.
 */
export function evidenceFaq(
  view: Ledger,
  question: string,
  sentence: string,
  language: Language,
): { question: string; answer: string }[] {
  const c = ledgerCopy[language];
  const join = (parts: string[]) => parts.join(language === "zh-CN" ? "" : " ");
  if (view.state === "unpublished") return [{ question, answer: join([sentence, c.notPublished]) }];
  if (view.state === "none") return [{ question, answer: join([sentence, c.none, c.noneWhy]) }];
  const sep = colon(language);
  const stop = language === "zh-CN" ? "。" : ".";
  const ended = (text: string) => (/[.。]$/.test(text) ? text : `${text}${stop}`);
  return [
    { question, answer: join([view.answer, ...view.notes]) },
    {
      question: questionCopy[language].howCounted,
      answer: join([
        // The six counts side by side with their definitions, as the page shows them.
        ...EVIDENCE_ORDER.map((t) => {
          const meaning = typeMeaning(t, language);
          const count = ended(`${typeName(t, language)}${sep}${view.stats.byType[t]}`);
          return meaning ? `${count}${language === "zh-CN" ? "" : " "}${ended(meaning)}` : count;
        }),
        c.machine,
      ]),
    },
  ];
}

/**
 * The structured data of a market or an occupation page: a Dataset named by
 * the page's question, with its Markdown copy and the Agent interface's JSON
 * for the same subject as downloads, and the FAQ the page answers.
 */
export function evidenceLd(
  language: Language,
  page: { kind: "market" | "occupation"; name: string; slug: string; path: string; sentence: string; rows: ObservationRow[] },
): object[] {
  const question = pageQuestion(page.kind, page.name, language);
  const faq = evidenceFaq(ledger(page.rows, page.name, language), question, page.sentence, language);
  const api = (route: string) => `${SITE_URL}/api/agent/${route}?${page.kind}=${encodeURIComponent(page.slug)}&language=${language}`;
  return [
    datasetLd(language, {
      name: question,
      description: faq[0].answer,
      path: page.path,
      measured: EVIDENCE_ORDER.map((t) => typeName(t, language)),
      downloads: [
        { url: absoluteUrl(language, `${page.path}/raw.md`), type: "text/markdown" },
        { url: api("summary"), type: "application/json" },
        { url: api("observations"), type: "application/json" },
      ],
    }),
    faqLd(language, faq),
  ].filter((block): block is object => block !== null);
}
