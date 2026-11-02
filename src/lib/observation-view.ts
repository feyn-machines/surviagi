import { termDefinition, termNameOrRaw } from "@/components/ontology-labels";
import { bilingual, type Language } from "@/lib/i18n";
import { colon } from "@/lib/markdown-copy";
import { plural } from "@/lib/plural";
import {
  EVIDENCE_ORDER,
  byStrength,
  manifest,
  observationDate,
  observationStats,
  observationsPublished,
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

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), plural(template, values));

export function typeName(type: EvidenceType, language: Language): string {
  return termNameOrRaw("event_basis", type, language);
}

export function typeMeaning(type: EvidenceType, language: Language): string | null {
  return termDefinition("event_basis", type, language)?.text ?? null;
}

/** "1 production use, 1 measurement" / "生产使用 1 条、测量 1 条": the types that occur, strongest first. */
function typesLine(stats: ObservationStats, language: Language): string {
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

export type Overview =
  | { state: "unpublished"; title: string }
  | { state: "some"; title: string; stats: ObservationStats; answer: string; notes: string[] };

/**
 * The same counts over a whole list page (Issue #32): every observation mapped
 * to at least one market, or one occupation, once each, and how many of them
 * have any. `byPage` holds each page's own rows, so the per-row column and this
 * total come from the same mapping.
 */
export function overview(byPage: ObservationRow[][], kind: "markets" | "occupations", language: Language): Overview {
  const c = ledgerCopy[language];
  const title = fill(c.acrossTitle, { kind: c[kind] });
  if (!observationsPublished()) return { state: "unpublished", title };
  const date = manifest()?.generated_at ?? null;
  const rows = [...new Map(byPage.flat().map((row) => [row.observation_id, row])).values()];
  const stats = observationStats(rows, date);
  const values = { date: date?.slice(0, 10) ?? "", n: stats.total, m: byPage.filter((p) => p.length > 0).length, total: byPage.length, kind: c[kind] };
  if (rows.length === 0) return { state: "some", title, stats, answer: fill(c.acrossNone, values), notes: [] };
  return {
    state: "some",
    title,
    stats,
    answer: fill(c.across, { ...values, types: typesLine(stats, language) }),
    notes: [...notesOf(stats, language), c.acrossWhy],
  };
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

function observationMarkdown(row: ObservationRow, language: Language): string[] {
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
