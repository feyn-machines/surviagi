import { termNameOrRaw } from "@/components/ontology-labels";
import { bilingual, localizedPath, type Language } from "@/lib/i18n";
import { colon, link } from "@/lib/markdown-copy";
import { fill, ledger, ledgerCopy, observationMarkdown } from "@/lib/observation-view";
import { topicStands } from "@/lib/topic-standing";
import {
  marketSlug,
  markets,
  observationsOfMarket,
  observationsOfOccupation,
  isObservationEvidence,
  observationById,
  occupationSlug,
  occupations,
  topics,
  type ObservationRow,
  type ObservationStats,
  type Topic,
  type TopicEvidence as TopicEvidenceRow,
  type TopicObservationEvidence,
  type TopicUpdateEvidence,
} from "@/lib/snapshot";

/**
 * A topic and the evidence page of what it is about, linked both ways (Issue
 * #32): a topic page sets the observations mapped to its occupation or market
 * beside the question, and that page lists the topics asked about it.
 *
 * Observations are not assigned to a topic's answers. The topic page shows the
 * ones pointing each way side by side and sends the reader to the evidence
 * page for the rest; it still declares no answer.
 */

export const topicEvidenceCopy = bilingual({
  en: {
    title: "What the observations about {name} show",
    lead: "Observations mapped to {name}, read from collected posts. They are not assigned to the answers above; the ones pointing each way are set side by side.",
    noneHere: "None among the observations mapped here.",
    all: "All {n} {n|observation|observations} about {name}, by evidence type",
    topicsTitle: "Questions argued about it",
    topicsLead: "Closed questions argued in the posts collected. A topic page lists who argues each answer and declares none.",
    topicLine: "{a} {a|account|accounts} · {n} answers",
    latest: "latest claim {date}",
    talkTitle: "Under discussion",
    talkLead: "Questions about {name} that one account has raised so far, with no observation about it yet. Each gets a page of its own once a second account or an observation arrives.",
    talkLine: "@{handle} says: {answer}",
    sourceWord: "source",
    singleNote: "Only one account has raised this so far and no observation covers {name}, so it is listed under discussion on that page and does not ask to be indexed.",
    singleNoteLoose: "Only one account has raised this so far and it is not mapped to an occupation or market, so this page does not ask to be indexed.",
  },
  "zh-CN": {
    title: "关于{name}的观察怎么说",
    lead: "映射到{name}的观察，读自采集到的帖子。观察不归到上面的某个选项；指向两边的并排列出。",
    noneHere: "映射到这里的观察里没有。",
    all: "{name}的全部 {n} 条观察，按证据类型",
    topicsTitle: "关于它的话题",
    topicsLead: "采集到的帖子里争论的封闭问题。话题页列出谁主张哪个选项，不给出答案。",
    topicLine: "{a} 个账号 · {n} 个选项",
    latest: "最近主张于 {date}",
    talkTitle: "讨论中",
    talkLead: "关于{name}、目前只有一个账号提过且还没有观察的问题。出现第二个账号或第一条观察后，各自单独成页。",
    talkLine: "@{handle} 的答案：{answer}",
    sourceWord: "出处",
    singleNote: "目前只有一个账号提过这个问题，{name}也没有观察，所以它在{name}页的“讨论中”列出，本页不要求被收录。",
    singleNoteLoose: "目前只有一个账号提过这个问题，也没有映射到职业或赛道，所以本页不要求被收录。",
  },
});

/** How many observations pointing each way a topic page lists before sending the reader on. */
const SHOWN = 3;

/** What a topic is about, when that is an occupation or a market with a page in this release. */
export type TopicSubject = { kind: "occupation" | "market"; id: string; name: string; path: string };

export function topicSubject(topic: Topic, language: Language): TopicSubject | null {
  // Named as the catalog names it on its own page, not as the topic was worded.
  const about = topic.about;
  const zh = language === "zh-CN";
  if (about?.kind === "occupation") {
    const o = occupations().find((row) => row.occupation_id === about.id);
    if (o) return { kind: "occupation", id: o.occupation_id, name: (zh ? o.label_zh_cn ?? o.label_en : o.label_en) ?? o.occupation_id, path: `/occupations/${occupationSlug(o.occupation_id)}` };
  }
  if (about?.kind === "market") {
    const m = markets().find((row) => row.id === about.id);
    if (m) return { kind: "market", id: m.id, name: (zh ? m.zh_cn : m.en) ?? m.en, path: `/markets/${marketSlug(m.id)}` };
  }
  return null;
}

export type TopicEvidence =
  | { state: "unpublished"; subject: TopicSubject }
  | { state: "none"; subject: TopicSubject }
  | {
      state: "some";
      subject: TopicSubject;
      stats: ObservationStats;
      /** The evidence page's own sentence, so the two pages say the same numbers. */
      answer: string;
      /** The strongest few pointing each way; neutral ones are only counted. */
      takesOn: ObservationRow[];
      stillNeeded: ObservationRow[];
    };

/** The observations of a topic's subject, or null when the topic has no subject page to send a reader to. */
export function topicEvidence(topic: Topic, language: Language): TopicEvidence | null {
  const subject = topicSubject(topic, language);
  if (!subject) return null;
  const rows = subject.kind === "occupation" ? observationsOfOccupation(subject.id) : observationsOfMarket(subject.id);
  const view = ledger(rows, subject.name, language);
  if (view.state === "unpublished") return { state: "unpublished", subject };
  if (view.state === "none") return { state: "none", subject };
  const ordered = [...view.strongest, ...view.otherWay, ...view.rest];
  return {
    state: "some",
    subject,
    stats: view.stats,
    answer: view.answer,
    takesOn: ordered.filter((r) => r.direction === "ai_takes_on").slice(0, SHOWN),
    stillNeeded: view.otherWay.slice(0, SHOWN),
  };
}

/** The two headings of a topic page's observations: the direction vocabulary's own names. */
export const directionName = (direction: ObservationRow["direction"], language: Language) =>
  termNameOrRaw("observation_direction", direction, language);

/** Topics about one occupation or market, the most argued first. */
export function topicsAbout(kind: "occupation" | "market", id: string): Topic[] {
  return topics()
    .filter((t) => t.about?.kind === kind && t.about.id === id)
    .sort((a, b) => b.accounts - a.accounts || (b.latest_claim_at ?? "").localeCompare(a.latest_claim_at ?? "") || a.slug.localeCompare(b.slug));
}

/** A question only one account has raised: its text and what that account answered, for the subject page's list. */
export type Mention = { topic: Topic; answer: string; handle: string; date: string; url: string | null };

/** The topics about one subject split into those with a page of their own and the mentions folded into its page. */
export function splitTopics(list: Topic[], language: Language): { pages: Topic[]; mentions: Mention[] } {
  const pages = list.filter(topicStands);
  const mentions: Mention[] = [];
  for (const topic of list) {
    if (topicStands(topic)) continue;
    const claim = [...topic.claims].sort((a, b) => b.published_at.localeCompare(a.published_at))[0];
    const option = claim ? topic.options.find((o) => o.key === claim.option) : undefined;
    if (!claim || !option) continue;
    mentions.push({ topic, answer: option.text[language], handle: claim.handle, date: claim.published_at.slice(0, 10), url: claim.url });
  }
  return { pages, mentions };
}

export function topicLine(topic: Topic, language: Language): string {
  const c = topicEvidenceCopy[language];
  const line = fill(c.topicLine, { a: topic.accounts, n: topic.options.length });
  return topic.latest_claim_at ? `${line} · ${fill(c.latest, { date: topic.latest_claim_at.slice(0, 10) })}` : line;
}

/** A topic page's observations as Markdown lines, under a heading of level two. */
export function topicEvidenceMarkdown(view: TopicEvidence, language: Language): string[] {
  const c = topicEvidenceCopy[language];
  const name = view.subject.name;
  const body = [`## ${fill(c.title, { name })}`, "", fill(c.lead, { name }), ""];
  const page = `${view.subject.path}#evidence`;
  if (view.state !== "some") {
    const lc = ledgerCopy[language];
    return [...body, view.state === "unpublished" ? lc.notPublished : `${lc.none} ${lc.noneWhy}`, "", link(language, name, page), ""];
  }
  body.push(`> ${view.answer}`, "");
  for (const [direction, rows] of [["ai_takes_on", view.takesOn], ["human_still_needed", view.stillNeeded]] as const) {
    body.push(`### ${directionName(direction, language)}`, "");
    if (rows.length === 0) body.push(c.noneHere);
    for (const row of rows) body.push(...observationMarkdown(row, language));
    body.push("");
  }
  body.push(link(language, fill(c.all, { n: view.stats.total, name }), page), "");
  return body;
}

/** The topics of an occupation or market page as Markdown lines; nothing when none is asked about it. */
export function topicsMarkdown(list: Topic[], language: Language, subjectName: string): string[] {
  const { pages, mentions } = splitTopics(list, language);
  const c = topicEvidenceCopy[language];
  const sep = colon(language);
  const out: string[] = [];
  if (pages.length > 0) {
    out.push(
      `## ${c.topicsTitle}`, "", c.topicsLead, "",
      ...pages.map((t) => `- ${link(language, t.question[language], `/topics/${t.slug}`)}${sep}${topicLine(t, language)}`),
      "",
    );
  }
  if (mentions.length > 0) {
    out.push(
      `## ${c.talkTitle}`, "", fill(c.talkLead, { name: subjectName }), "",
      ...mentions.map((m) => `- ${m.topic.question[language]}${sep}${fill(c.talkLine, { handle: m.handle, answer: m.answer })} · ${m.date}${m.url ? ` · [${c.sourceWord}](${m.url})` : ""}`),
      "",
    );
  }
  return out;
}

/** The evidence page's address for a topic's subject, in the reader's language. */
export const subjectHref = (subject: TopicSubject, language: Language) => `${localizedPath(language, subject.path)}#evidence`;

/**
 * What weighs on one answer of a topic: observations pointing each way, each
 * with its sign (contract 1.8.0), or the updates an older release judged.
 * An observation the release no longer carries is left out; the counts on the
 * answer still include it, as the data release made them.
 */
export type AnswerEvidence = {
  observations: { sign: "supports" | "contradicts"; confidence: number; row: ObservationRow }[];
  updates: TopicUpdateEvidence[];
};

export function answerEvidence(topic: Topic, option: string): AnswerEvidence {
  const mine = topic.evidence.filter((row: TopicEvidenceRow) => row.option === option);
  const observations: AnswerEvidence["observations"] = [];
  for (const row of mine.filter(isObservationEvidence) as TopicObservationEvidence[]) {
    const found = observationById(row.observation_id);
    if (found) observations.push({ sign: row.sign, confidence: row.confidence, row: found });
  }
  return { observations, updates: mine.filter((row): row is TopicUpdateEvidence => !isObservationEvidence(row)) };
}
