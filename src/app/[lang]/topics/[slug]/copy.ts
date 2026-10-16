import { bilingual, type Language } from "@/lib/i18n";
import { plural } from "@/lib/plural";
import type { Topic } from "@/lib/snapshot";

/** The topic page's words, shared with its Markdown copy (`raw.md`). The page declares no answer. */
export const copy = bilingual({
  en: {
    back: "← All topics",
    replacement: "JOB",
    viability: "BUSINESS",
    since: "Open since",
    accounts: "Accounts",
    posts: "Posts",
    evidence: "Evidence",
    answers: "Answers",
    argued: "argued by",
    for: "for",
    against: "against",
    evidenceLabel: "Evidence",
    claimsLabel: "Who argues it",
    supports: "SUPPORTS",
    contradicts: "CONTRADICTS",
    nobody: "Nobody argues this yet.",
    outside: "not in the panel",
    source: "Source ↗",
    quarters: "By quarter",
    quarter: "Quarter",
    describe: "{q} {n} answers, argued by {a} accounts in the posts collected.",
    answer: "As of {date}, {a} {a|account argues|accounts argue} for one of this question's {n} answers in the {p} {p|post|posts} collected, and {e} {e|update weighs|updates weigh} for or against them.",
    answerTop: "Argued by the most accounts: “{top}” ({k}).",
    answerNone: "As of {date}, no account in the posts collected argues for any of this question's {n} answers.",
    noVerdict: "SurviAGI declares no answer.",
  },
  "zh-CN": {
    back: "← 全部话题",
    replacement: "职业",
    viability: "生意",
    since: "提出于",
    accounts: "账号",
    posts: "帖子",
    evidence: "证据",
    answers: "选项",
    argued: "主张的账号",
    for: "支持",
    against: "反驳",
    evidenceLabel: "证据",
    claimsLabel: "谁这么主张",
    supports: "支持",
    contradicts: "反驳",
    nobody: "还没有人主张这个答案。",
    outside: "名单外",
    source: "来源 ↗",
    quarters: "按季度",
    quarter: "季度",
    describe: "{q} {n} 个选项，采集到的帖子里有 {a} 个账号主张过。",
    answer: "截至 {date}，采集到的 {p} 条帖子里，有 {a} 个账号主张这个问题 {n} 个选项中的一个，{e} 条更新支持或反驳其中的选项。",
    answerTop: "主张的账号最多的是“{top}”（{k} 个）。",
    answerNone: "截至 {date}，采集到的帖子里还没有账号主张这个问题 {n} 个选项中的任何一个。",
    noVerdict: "SurviAGI 不给出答案。",
  },
});

/**
 * The page's answer in one dated sentence: how many accounts argue, in how many
 * posts, how many updates weigh in, and the answer argued by the most accounts
 * when one leads. It counts who argued; it does not say who is right.
 */
export function answerSentence(topic: Topic, language: Language, date: string): string {
  const c = copy[language];
  const values = { date, a: topic.accounts, n: topic.options.length, p: topic.posts, e: topic.evidence.length };
  const fill = (template: string, more: Record<string, string | number> = {}) => {
    let out = plural(template, { ...values, ...more });
    for (const [key, value] of Object.entries({ ...values, ...more })) out = out.replaceAll(`{${key}}`, String(value));
    return out;
  };
  if (!topic.accounts) return `${fill(c.answerNone)} ${c.noVerdict}`.replace("。 ", "。");
  const most = Math.max(...topic.options.map((o) => o.accounts));
  const leaders = topic.options.filter((o) => o.accounts === most);
  const top = leaders.length === 1 && most > 0 ? fill(c.answerTop, { top: leaders[0].text[language], k: most }) : "";
  return [fill(c.answer), top, c.noVerdict].filter(Boolean).join(language === "zh-CN" ? "" : " ");
}
