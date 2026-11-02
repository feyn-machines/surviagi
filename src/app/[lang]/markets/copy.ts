import { bilingual } from "@/lib/i18n";
import { plural } from "@/lib/plural";

/**
 * Copy for the two market pages, in one file because the server page and the
 * interactive part of the same page have to say the same words, and a client
 * component cannot reach into the snapshot module to fetch them.
 *
 * One line of lead per block. No page here ranks a market: it counts the
 * collected updates that bear on each kind of work and links them.
 */

export const indexCopy = bilingual({
  en: {
    eyebrow: "Markets",
    title: "Markets",
    lead: "A kind of work a business sells. An AI update lands here, not on a job title.",
    statMarkets: "Markets",
    statMarketsNote: "{n} kinds of work in them",
    statCovered: "With updates",
    statCoveredNote: "{n} more that no collected update mentioned",
    statUpdates: "Updates linked",
    statUpdatesNote: "Collected updates that bear on a kind of work in a market",
    tableTitle: "All markets",
    tableLead: "A blank market means nothing was collected about it, not that AI does none of it.",
    tableLabel: "Markets table",
    searchLabel: "Search",
    searchPlaceholder: "English or Chinese name",
    coverageLabel: "Updates",
    coverageAll: "All",
    coverageWith: "With updates",
    coverageWithout: "No updates",
    sortLabel: "Sort by",
    sortUpdates: "Updates",
    sortActivities: "Work",
    sortScored: "Work with updates",
    sortOccupations: "Occupations",
    showing: "Showing {n} of {total} markets",
    colMarket: "Market",
    colActivities: "Work",
    colAssessed: "Work with updates",
    colUpdates: "Updates",
    colOccupations: "Occupations served",
    emptyTitle: "No market matches.",
    emptyWhy: "No market name contains what you typed, with the update filter you picked.",
    reset: "Clear the filters",
    empty: "No market is published in this snapshot.",
  },
  "zh-CN": {
    eyebrow: "赛道",
    title: "赛道",
    lead: "企业卖给客户的一类工作。AI 更新落在这里，不落在职位上。",
    statMarkets: "赛道",
    statMarketsNote: "其中共 {n} 项工作",
    statCovered: "有更新",
    statCoveredNote: "另有 {n} 个赛道没被任何采集到的更新谈到",
    statUpdates: "关联的更新",
    statUpdatesNote: "触及某个赛道里某项工作的已采集更新",
    tableTitle: "全部赛道",
    tableLead: "赛道是空的，只说明没采集到它，不说明 AI 做不了。",
    tableLabel: "赛道表",
    searchLabel: "搜索",
    searchPlaceholder: "中文名或英文名",
    coverageLabel: "更新",
    coverageAll: "全部",
    coverageWith: "有更新",
    coverageWithout: "无更新",
    sortLabel: "排序",
    sortUpdates: "更新数",
    sortActivities: "工作数",
    sortScored: "有更新的工作",
    sortOccupations: "服务职业数",
    showing: "显示 {total} 个赛道中的 {n} 个",
    colMarket: "赛道",
    colActivities: "工作数",
    colAssessed: "有更新的工作",
    colUpdates: "更新数",
    colOccupations: "服务的职业",
    emptyTitle: "没有赛道符合当前条件。",
    emptyWhy: "在你选的更新条件下，没有赛道名包含你输入的字。",
    reset: "清除筛选",
    empty: "这份快照里没有发布任何赛道。",
  },
});

export const detailCopy = bilingual({
  en: {
    eyebrow: "Market",
    back: "All markets",
    metaSuffix: "Market",
    metaDescription: "{name}: {count} kinds of work, each with the AI updates that bear on it.",
    lead: "Each kind of work in this market, and the collected AI updates that bear on it, with their sources.",
    answer: "As of {date}, {updates} collected {updates|update bears|updates bear} on {scored} of the {n} {n|kind|kinds} of work in {name}.",
    answerNone: "As of {date}, no collected update bears on any of the {n} {n|kind|kinds} of work in {name}.",
    statActivities: "Work",
    statActivitiesNote: "{n} with updates",
    statUpdates: "Updates",
    statUpdatesNote: "Each links to its original post",
    statOccupations: "Occupations",
    statOccupationsNote: "linked to this market",
    activitiesTitle: "Work in this market",
    activitiesLead: "Open a row to read the updates that bear on it.",
    activitiesNone: "No work is published for this market.",
    updatesLabel: "Updates table",
    colUpdate: "Update",
    colWho: "From",
    colWhen: "When",
    updates: "updates",
    tasks: "{n} {n|task|tasks}",
    noUpdatesTitle: "No update in the collected window mentioned this work.",
    noUpdatesWhy: "That is a statement about the collection, not about the work.",
    occupationsTitle: "Occupations this market is served by",
    occupationsLead: "One market is served by several occupations, so these are not shares of a job.",
    occupationsLabel: "Occupations table",
    occupationsNone: "No occupation has been linked to this market yet.",
    occupationsWhy: "The market-to-occupation edges are published per market; this one has none.",
    colOccupation: "Occupation",
    colConfidence: "Confidence",
    noReading: "no update mentioned it",
    source: "source",
    alsoSays: "@{handle} ({nature}) also says so: {title}",
  },
  "zh-CN": {
    eyebrow: "赛道",
    back: "全部赛道",
    metaSuffix: "赛道",
    metaDescription: "{name}：{count} 类工作，以及触及每类工作的 AI 更新。",
    lead: "这个赛道里的每项工作，以及采集到的、触及它的 AI 更新和出处。",
    answer: "截至 {date}，采集到的 {updates} 条更新触及了{name}的 {n} 项工作中的 {scored} 项。",
    answerNone: "截至 {date}，采集到的更新里没有一条触及{name}的 {n} 项工作。",
    statActivities: "工作",
    statActivitiesNote: "其中 {n} 项有更新",
    statUpdates: "更新",
    statUpdatesNote: "每条都链到原帖",
    statOccupations: "职业",
    statOccupationsNote: "与这个赛道关联",
    activitiesTitle: "这个赛道里的工作",
    activitiesLead: "点开一条，读触及它的那几条更新。",
    activitiesNone: "这个赛道没有发布任何工作。",
    updatesLabel: "更新表",
    colUpdate: "更新",
    colWho: "来自",
    colWhen: "时间",
    updates: "条更新",
    tasks: "{n} 项任务",
    noUpdatesTitle: "采集窗口里没有一条更新谈到这项工作。",
    noUpdatesWhy: "这是关于采集的陈述，不是关于这份工作的陈述。",
    occupationsTitle: "服务这个赛道的职业",
    occupationsLead: "一个赛道由多个职业共同服务，所以这些不是对某份工作的切分。",
    occupationsLabel: "职业表",
    occupationsNone: "还没有职业与这个赛道建立关联。",
    occupationsWhy: "赛道—职业的对应关系按赛道发布，这个赛道目前一条都没有。",
    colOccupation: "职业",
    colConfidence: "置信度",
    noReading: "没有更新谈到它",
    source: "原文",
    alsoSays: "@{handle}（{nature}）也这么说：{title}",
  },
});

/** `{n}` and friends, filled in without pulling a formatter into the bundle, after `{n|one|other}`
    agreement (see `plural`). */
export function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    plural(template, values),
  );
}

/** One grouping for both languages, so a number never changes shape mid-page. */
const numberFormat = new Intl.NumberFormat("en-US");

export function count(value: number): string {
  return numberFormat.format(value);
}
