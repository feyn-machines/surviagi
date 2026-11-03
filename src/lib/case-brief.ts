import { bilingual, type Language } from "@/lib/i18n";
import { fill } from "@/lib/observation-view";
import { byStrength, observationDate, observationStats, type ObservationRow } from "@/lib/snapshot";

/**
 * What a first-time reader of an occupation page sees before any count: one
 * plain sentence on where the evidence stands, then the few cases that carry it,
 * each with its source, and the few that point the other way. Everything is
 * chosen from the observations already on the page; nothing here is scored,
 * and the sentence says only what the counts say.
 */

export const briefCopy = bilingual({
  en: {
    lead: "How far has AI got in this job? Real cases from public posts, each with its source.",
    verdictBoth: "Of the {n} public posts we read about {name}, {p} {p|describes|describe} a company using AI for this work in real operations, and {a} {a|says|say} a person is still needed or the AI fell short.",
    verdictUse: "Of the {n} public posts we read about {name}, {p} {p|describes|describe} a company using AI for this work in real operations. None says a person is still needed.",
    verdictNoUse: "Of the {n} public posts we read about {name}, none describes a company using AI for this work in real operations yet; they are mostly people trying it out or makers announcing it.",
    caveat: "Read from posts by a model, not checked by a person. It shows what was collected, not the whole job.",
    useTitle: "Where AI is already doing this work",
    useLead: "The best-sourced cases first. Every case links to the post it comes from.",
    againstTitle: "Where it fell short, or people came back",
    againstLead: "Cases saying a person is still needed.",
    source: "Source post",
    sourceOn: "from the post",
    foldTitle: "All {n} records, counts and method",
    foldLead: "For readers who want to check the numbers.",
    english: "Quotes and task wording are in English, as the posts were written.",
  },
  "zh-CN": {
    lead: "这份工作里，AI 现在做到哪一步了？下面是公开帖子里有出处的真实案例。",
    verdictBoth: "我们读到的 {n} 条关于{name}的公开说法里，有 {p} 条是公司在真实业务里用 AI 做这类工作，另有 {a} 条说仍需要人，或者 AI 没做到。",
    verdictUse: "我们读到的 {n} 条关于{name}的公开说法里，有 {p} 条是公司在真实业务里用 AI 做这类工作，没有一条说仍需要人。",
    verdictNoUse: "我们读到的 {n} 条关于{name}的公开说法里，还没有一条是公司在真实业务里用 AI 做这类工作；大多是个人试用，或出品方自己宣布。",
    caveat: "这些由模型从帖子里读出，没有人核对。它说明的是我们采集到了什么，不是这份工作的全部。",
    useTitle: "已经有人在用",
    useLead: "有出处的案例，依据最扎实的排在前面。每个案例都能点到原帖。",
    againstTitle: "也有说不行、又把人请回来的",
    againstLead: "说仍需要人的案例。",
    source: "原帖",
    sourceOn: "帖中原话",
    foldTitle: "查看全部 {n} 条记录、统计与方法",
    foldLead: "给想自己核对数字的读者。",
    english: "案例描述和引文是帖子的英文原文，暂未翻译。",
  },
});

export type BriefCase = {
  id: string;
  actor: string;
  date: string | null;
  task: string;
  figures: { value: string; what: string }[];
  url: string | null;
  quote: string | null;
};

export type CaseBrief = {
  verdict: string;
  using: BriefCase[];
  against: BriefCase[];
  total: number;
};

const USING = 4;
const AGAINST = 3;
const FIGURES = 2;
const QUOTE = 220;

const clip = (text: string) => (text.length <= QUOTE ? text : `${text.slice(0, QUOTE).replace(/\s+\S*$/, "")}…`);

/** A proper name starts with a capital or a Chinese character; "internet provider" is a description of someone, not a name. */
const isName = (row: ObservationRow) => /^[\p{Lu}\p{Lo}]/u.test(row.actor_name ?? "");

/** The strongest cases first, one per actor so a single company is not told twice; proper names before descriptions. */
function pick(rows: ObservationRow[], limit: number): ObservationRow[] {
  const sorted = [...rows].sort(byStrength);
  const named = sorted.filter(isName);
  const seen = new Set<string>();
  const out: ObservationRow[] = [];
  for (const row of [...named, ...sorted.filter((r) => !isName(r))]) {
    if (seen.has(row.actor_key)) continue;
    seen.add(row.actor_key);
    out.push(row);
    if (out.length === limit) break;
  }
  return out.sort(byStrength);
}

export function caseOf(row: ObservationRow, language: Language): BriefCase {
  const source = row.sources[0];
  return {
    id: row.observation_id,
    actor: row.actor_name ?? (language === "zh-CN" ? "未具名" : "unnamed"),
    date: observationDate(row),
    task: row.task,
    figures: row.facts.slice(0, FIGURES).map((f) => ({ value: `${f.value}${f.unit ? ` ${f.unit}` : ""}`, what: f.what })),
    url: source?.url ?? null,
    quote: source ? clip(source.quote) : null,
  };
}

/** Null when nothing is mapped to the page, so the page keeps its plain layout. */
export function caseBrief(rows: ObservationRow[], name: string, language: Language): CaseBrief | null {
  if (rows.length === 0) return null;
  const c = briefCopy[language];
  const stats = observationStats(rows, null);
  const production = stats.byType.production_use;
  const against = stats.against;
  const template = production === 0 ? c.verdictNoUse : against > 0 ? c.verdictBoth : c.verdictUse;
  const forward = rows.filter((r) => r.direction !== "human_still_needed");
  const backward = rows.filter((r) => r.direction === "human_still_needed");
  return {
    verdict: fill(template, { n: stats.total, name, p: production, a: against }),
    using: pick(forward, USING).map((r) => caseOf(r, language)),
    against: pick(backward, AGAINST).map((r) => caseOf(r, language)),
    total: stats.total,
  };
}
