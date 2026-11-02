import { vocabularyTerm, type VocabularyTerm } from "@/components/ontology-labels";
import { bilingual, type Language } from "@/lib/i18n";
import type { EventRow } from "@/lib/snapshot";

/** The update page's words, shared with its Markdown copy. */
export const copy = bilingual({
  en: {
    back: "← All updates",
    say: "This update bears on {n} {n|kind|kinds} of work in {m} {m|market|markets}.",
    work: "Work",
    markets: "Markets",
    sources: "Published at",
    views: "Views",
    reportsTitle: "What it reports",
    reportsSub: "As its source states it, in the original words. Each figure is shown with the sentence it was read from.",
    basis: "Basis",
    task: "Task",
    figure: "Figure",
    listTitle: "The work it bears on",
    listSub: "By market. Open a kind of work to see every other update that bears on it.",
    onMarket: "Open on the market page",
    sourcesFact: "Sources",
    source: "Source {i} ↗",
    original: "ORIGINAL",
    undated: "Undated",
    announced: "Announced {date}",
    all: "All updates",
    home: "Back to the overview",
    meta: "SurviAGI",
  },
  "zh-CN": {
    back: "← 全部更新",
    say: "这条更新涉及 {m} 条赛道的 {n} 项工作。",
    work: "工作",
    markets: "赛道",
    views: "浏览",
    reportsTitle: "它报告了什么",
    reportsSub: "按来源的说法，保留原文。每个数值都附上读出它的那句话。",
    basis: "依据",
    task: "做的事",
    figure: "数值",
    listTitle: "它涉及的工作",
    listSub: "按赛道排列。点开一项工作，查看谈到它的其他更新。",
    onMarket: "在赛道页打开",
    sourcesFact: "来源",
    sources: "发布于",
    source: "来源 {i} ↗",
    original: "原文",
    undated: "无日期",
    announced: "{date} 宣布",
    all: "全部更新",
    home: "回到全览",
    meta: "SurviAGI",
  },
});

/** What an update reports beyond its summary: the basis it rests on, the task and how it came out, and its figures. */
export function reports(update: Pick<EventRow, "basis" | "task" | "result" | "facts">, language: Language) {
  const name = (term: VocabularyTerm | null) => (term ? term[language] ?? term.en ?? null : null);
  const basis = vocabularyTerm("event_basis", update.basis);
  return {
    basis: name(basis),
    basisMeans: basis?.definition?.[language] ?? null,
    task: update.task ?? null,
    result: name(vocabularyTerm("event_result", update.result)),
    facts: (update.facts ?? []).map((f) => ({
      value: !f.unit ? f.value : f.unit === "%" ? `${f.value}%` : `${f.value} ${f.unit}`,
      what: f.what,
      // Some posts reach us HTML-escaped; the quote is shown as the post shows it.
      quote: f.quote.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
    })),
  };
}

/**
 * The date an update is shown under: when it happened, else when its earliest source post announced it
 * (said as such, since the two are not the same), else nothing.
 */
export function updateDate(c: { undated: string; announced: string }, update: { occurred_at: string | null; announced_at?: string }): string {
  if (update.occurred_at) return update.occurred_at.slice(0, 10);
  return update.announced_at ? c.announced.replace("{date}", update.announced_at.slice(0, 10)) : c.undated;
}
