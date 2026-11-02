import { termNameOrRaw } from "@/components/ontology-labels";
import { bilingual, localizedPath, type Language } from "@/lib/i18n";
import { colon, link } from "@/lib/markdown-copy";
import { fill, ledger, ledgerCopy, observationMarkdown } from "@/lib/observation-view";
import {
  marketSlug,
  markets,
  observationsOfMarket,
  observationsOfOccupation,
  occupationSlug,
  occupations,
  topics,
  type ObservationRow,
  type ObservationStats,
  type Topic,
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
export function topicsMarkdown(list: Topic[], language: Language): string[] {
  if (list.length === 0) return [];
  const c = topicEvidenceCopy[language];
  const sep = colon(language);
  return [
    `## ${c.topicsTitle}`, "", c.topicsLead, "",
    ...list.map((t) => `- ${link(language, t.question[language], `/topics/${t.slug}`)}${sep}${topicLine(t, language)}`),
    "",
  ];
}

/** The evidence page's address for a topic's subject, in the reader's language. */
export const subjectHref = (subject: TopicSubject, language: Language) => `${localizedPath(language, subject.path)}#evidence`;
