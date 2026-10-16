import type { Metadata } from "next";
import { getLocale } from "@/lib/locale";
import { pageMetadata } from "@/lib/seo";
import {
  chainEvents,
  coverage,
  evidence,
  events,
  activityById,
  progress,
  snapshotExists,
} from "@/lib/snapshot";
import {
  DataPageLinks,
  NoSnapshot,
  PageHeader,
  bilingual,
  dataStyles as d,
  isoDate,
} from "@/components/data-page";
import { UpdatesBrowser, type UpdateRow } from "./updates-browser";
import s from "./updates.module.css";

/** Rendered per request from the loaded data release, never at build time. */
export const dynamic = "force-dynamic";

/**
 * What 581 updates turned out to be worth.
 *
 * The claim of this page is a ratio and a skew: we read 581 updates, 256 of them
 * bore on any work at all, and where they came from is nothing like even -
 * Google alone filed more than a quarter. Both are numbers, so both are drawn,
 * not described. The 325 that landed on nothing are listed WITH the rest,
 * because a feed filtered down to the productive half would imply a collection
 * far better than the one we ran.
 *
 * Every row is rendered here, on the server. The browser component adds search,
 * the publisher filter, the sort and the per-update readings on top of a list
 * that is already complete with JavaScript off.
 *
 * There is deliberately no `/updates/[id]`: a page of ours restating a post we
 * did not write adds a hop and a chance to distort, so the title is the link and
 * it leaves the site.
 */

const copy = bilingual({
  en: {
    eyebrow: "Updates",
    title: "AI updates",
    lead: "AI updates that bear on specific work. Newest first.",
    more: "Show {n} more",
    windowLabel: "Collection window",
    statRead: "Updates read",
    statLanded: "Landed on work",
    statSilent: "Landed on nothing",
    legendLanded: "{n} landed on work",
    legendRest: "{n} bore on no work",
    fromEyebrow: "Where they came from",
    fromTitle: "The feed is not even",
    fromLead: "Pick a publisher to hold the table to it.",
    tableEyebrow: "Every update",
    tableTitle: "All 581, newest first",
    tableLead: "The ones that landed on nothing are listed too.",
    tableLabel: "Updates table",
    searchLabel: "Search titles and publishers",
    searchPlaceholder: "agent, robot, Gemini…",
    filterLabel: "Show",
    filterAll: "All",
    filterLanded: "Landed",
    filterSilent: "Landed on nothing",
    sortLabel: "Sort",
    sortTime: "Newest",
    sortReach: "Most work reached",
    showing: "{n} of {total} shown",
    empty: "No update matches this search, this publisher and this filter together. Widen one of them; nothing was hidden.",
    reset: "Clear",
    colWhen: "When",
    colUpdate: "Update",
    colFrom: "From",
    colLanded: "Bears on (work / markets)",
    colTop: "Highest",
    runsEyebrow: "Provenance",
    runsTitle: "The runs that produced these rows",
    runsLead: "Every pass that read the collection, and whether it finished.",
    colRun: "Method",
    colStatus: "Status",
    colDecided: "Decided",
    colStarted: "Started",
    noDecided: "This run recorded no decision count.",
    openSource: "opens the original post",
    readingsOpen: "{n} pieces of evidence",
    readingsClose: "Hide evidence",
    noDate: "No publication time was recorded for this update.",
    noOrg: "No publisher was resolved for this update.",
    noSource: "No source URL was retained for this update.",
    noLevel: "none",
    capNote: "capped {cap}",
    empty0: "No updates are published in this snapshot.",
  },
  "zh-CN": {
    eyebrow: "更新",
    title: "AI 更新",
    lead: "涉及具体工作的 AI 更新，最新在前。",
    more: "再显示 {n} 条",
    windowLabel: "采集窗口",
    statRead: "收录的更新",
    statLanded: "涉及工作",
    statSilent: "未涉及工作",
    legendLanded: "{n} 条涉及工作",
    legendRest: "{n} 条未涉及任何工作",
    fromEyebrow: "来自哪里",
    fromTitle: "来源严重偏斜",
    fromLead: "点一个发布方，下面的表就只看它。",
    tableEyebrow: "全部更新",
    tableTitle: "581 条，最新在前",
    tableLead: "未涉及工作的更新也在列表里。",
    tableLabel: "更新表",
    searchLabel: "搜标题和发布方",
    searchPlaceholder: "智能体、机器人、Gemini…",
    filterLabel: "只看",
    filterAll: "全部",
    filterLanded: "涉及工作",
    filterSilent: "未涉及工作",
    sortLabel: "排序",
    sortTime: "最新",
    sortReach: "打到的工作最多",
    showing: "显示 {n} / {total}",
    empty: "这个搜索词、这个发布方、这个筛选三个条件同时满足的更新一条也没有。放宽其中一个；没有任何内容被隐藏。",
    reset: "清空",
    colWhen: "时间",
    colUpdate: "更新",
    colFrom: "来自",
    colLanded: "涉及（工作 / 赛道）",
    colTop: "最高",
    runsEyebrow: "溯源",
    runsTitle: "产出这些行的运行",
    runsLead: "每一次读过采集的判断轮次，以及它有没有跑完。",
    colRun: "方法",
    colStatus: "状态",
    colDecided: "已判定",
    colStarted: "开始",
    noDecided: "这次运行没有记录判定数。",
    openSource: "打开原帖",
    readingsOpen: "{n} 条证据",
    readingsClose: "收起证据",
    noDate: "这条更新没有记录发布时间。",
    noOrg: "这条更新没有解析出发布方。",
    noSource: "这条更新没有保留源头链接。",
    noLevel: "无",
    capNote: "{cap} 封顶",
    empty0: "本次快照没有发布任何更新。",
  },
});

export async function generateMetadata(): Promise<Metadata> {
  const { language } = await getLocale();
  const c = copy[language];
  return pageMetadata({ language, path: "/updates", title: c.title, description: c.lead });
}

export default async function UpdatesPage() {
  const { language } = await getLocale();
  const c = copy[language];
  if (!snapshotExists()) {
    return (
      <div className={s.page}>
        <PageHeader eyebrow={c.eyebrow} title={c.title} lead={c.lead} />
        <NoSnapshot language={language} />
      </div>
    );
  }

  // The ladder's own words, read from the snapshot. Nothing in src/ restates
  // them: pnpm ontology:check fails the build if anything does.
  const words = progress()?.levels ?? {};
  const caps = progress()?.tier_caps ?? null;
  const rung = (level: number | null | undefined): string | null => {
    if (level === null || level === undefined) return null;
    const step = String(Math.floor(level));
    const word = words[step]?.[language];
    return word ? `L${step} · ${word}` : `L${step}`;
  };

  const landed = new Map(chainEvents().map((e) => [e.event_id, e]));
  const readingsByEvent = new Map<string, UpdateRow["readings"]>();
  for (const row of evidence()) {
    const activity = activityById(row.activity_id);
    const list = readingsByEvent.get(row.event_id) ?? [];
    const tier = row.evidence_tier as keyof NonNullable<typeof caps>;
    const cap = caps?.[tier];
    list.push({
      activity:
        (language === "zh-CN" ? activity?.label_zh_cn : activity?.label_en) ??
        activity?.label_en ??
        row.activity_id,
      market: (language === "zh-CN" ? activity?.market_zh_cn : activity?.market_en) ?? null,
      level: rung(row.level),
      // Only when the tier actually held the reading down: a cap that did not
      // bite is machinery, and saying so on every row would be noise.
      cap:
        cap !== undefined &&
        row.observed_level !== null &&
        row.level !== null &&
        row.observed_level > row.level
          ? `${row.evidence_tier} → L${cap}`
          : null,
    });
    readingsByEvent.set(row.event_id, list);
  }

  // Only updates that bear on some work are listed; the rest say nothing this page can show.
  const rows: UpdateRow[] = [...events()]
    .filter((row) => landed.has(row.event_id))
    .sort((a, b) => (b.occurred_at ?? "").localeCompare(a.occurred_at ?? ""))
    .map((row) => {
      const hit = landed.get(row.event_id);
      return {
        id: row.event_id,
        title: row.title,
        date: isoDate(row.occurred_at),
        org: (language === "zh-CN" ? row.org_name_zh_cn : row.org_name) ?? row.org_name,
        orgKey: row.org_name,
        url: row.source_urls?.[0] ?? null,
        activities: hit?.activities ?? 0,
        markets: hit?.markets ?? 0,
        level: rung(hit?.top_level),
        readings: readingsByEvent.get(row.event_id) ?? [],
      };
    });

  // coverage names publishers in the registry's English; the table shows the
  // reader's language. The chart keeps the key and shows the label.
  const orgLabels = new Map<string, string>();
  for (const row of events()) {
    if (!row.org_name) continue;
    orgLabels.set(
      row.org_name,
      ((language === "zh-CN" ? row.org_name_zh_cn : row.org_name) ?? row.org_name) as string,
    );
  }
  // A button only for a publisher with rows here: coverage counts every update read, including the
  // ones with no publisher ("unattributed") and publishers none of whose updates bears on any work,
  // and a button for those would filter the list to nothing.
  const listed = new Set(rows.map((row) => row.orgKey));
  const orgs = (coverage()?.events_by_organisation ?? [])
    .filter((o) => o.events > 0 && listed.has(o.org))
    .map((o) => ({ ...o, label: orgLabels.get(o.org) ?? o.org }));
  const maxActivities = Math.max(1, ...rows.map((r) => r.activities));

  return (
    <div className={s.page}>
      <PageHeader eyebrow={c.eyebrow} title={c.title} lead={c.lead} />

      {rows.length === 0 ? (
        <p className={d.note}>{c.empty0}</p>
      ) : (
        <UpdatesBrowser
          rows={rows}
          orgs={orgs}
          maxActivities={maxActivities}
          language={language}
          copy={{
            fromEyebrow: c.fromEyebrow,
            fromTitle: c.fromTitle,
            fromLead: c.fromLead,
            tableEyebrow: c.tableEyebrow,
            tableTitle: c.tableTitle,
            tableLead: c.tableLead,
            tableLabel: c.tableLabel,
            searchLabel: c.searchLabel,
            searchPlaceholder: c.searchPlaceholder,
            filterLabel: c.filterLabel,
            filterAll: c.filterAll,
            filterLanded: c.filterLanded,
            filterSilent: c.filterSilent,
            sortLabel: c.sortLabel,
            sortTime: c.sortTime,
            sortReach: c.sortReach,
            showing: c.showing,
            empty: c.empty,
            reset: c.reset,
            colWhen: c.colWhen,
            colUpdate: c.colUpdate,
            colFrom: c.colFrom,
            colLanded: c.colLanded,
            colTop: c.colTop,
            openSource: c.openSource,
            readingsOpen: c.readingsOpen,
            readingsClose: c.readingsClose,
            noDate: c.noDate,
            noOrg: c.noOrg,
            noSource: c.noSource,
            noLevel: c.noLevel,
            capNote: c.capNote,
          }}
        />
      )}

      <DataPageLinks language={language} current="updates" />
    </div>
  );
}
