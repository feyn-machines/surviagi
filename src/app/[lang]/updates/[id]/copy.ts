import { bilingual } from "@/lib/i18n";

/** The update page's words, shared with its Markdown copy. */
export const copy = bilingual({
  en: {
    back: "← All updates",
    say: "This update bears on {n} {n|kind|kinds} of work in {m} {m|market|markets}. Highest level accepted: {level}.",
    work: "Work",
    markets: "Markets",
    top: "Highest accepted",
    views: "Views",
    listTitle: "The work it bears on",
    listSub: "Highest level first. Open a kind of work to see everything else that moved it.",
    claimed: "Claimed L{c} · Accepted L{a}",
    sources: "Published at",
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
    say: "这条更新涉及 {m} 条赛道的 {n} 项工作，最高采信到 {level}。",
    work: "工作",
    markets: "赛道",
    top: "最高采信",
    views: "浏览",
    listTitle: "它涉及的工作",
    listSub: "级别高的在前。点开一项工作，查看推动它的其他更新。",
    claimed: "宣称 L{c} · 采信 L{a}",
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

/**
 * The date an update is shown under: when it happened, else when its earliest source post announced it
 * (said as such, since the two are not the same), else nothing.
 */
export function updateDate(c: { undated: string; announced: string }, update: { occurred_at: string | null; announced_at?: string }): string {
  if (update.occurred_at) return update.occurred_at.slice(0, 10);
  return update.announced_at ? c.announced.replace("{date}", update.announced_at.slice(0, 10)) : c.undated;
}
