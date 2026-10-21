"use client";

import { plural } from "@/lib/plural";
import { useId, useMemo, useState } from "react";
import { useScrollPages } from "@/components/scroll-pages";
import Link from "next/link";
import { Bar, Blank, Head } from "@/components/blueprint";
import { useSeen } from "@/components/home/reveal";
import { bilingual, type Language } from "@/lib/i18n";
import { href } from "@/lib/routes";
import { byText } from "@/lib/order";
import s from "./detail.module.css";

/**
 * What AI has been shown to do in this occupation's work, one activity a row,
 * and every row opens onto the updates that put it there.
 *
 * The chain the site is built on is update → reading → activity, and the page
 * used to stop at the activity: a level appeared with no way to ask where it
 * came from. Opening a row shows each reading, which update it came from, what
 * the judge proposed, and what survived the evidence tier's cap - the largest
 * single effect in the method, and the thing a sceptical reader is looking for.
 */

export type ExplorerReading = {
  eventId: string;
  title: string;
  date: string | null;
  org: string | null;
  tier: string;
  /** What the judge proposed, before the evidence tier capped it. */
  observed: number | null;
  /** What survives the cap. The only number the site stands behind. */
  level: number | null;
  url: string | null;
};

export type ExplorerActivity = {
  id: string;
  label: string;
  search: string;
  marketLabel: string;
  marketSlug: string;
  level: number | null;
  tier: string | null;
  tasks: number;
  gated: boolean;
  readings: ExplorerReading[];
};

type FilterKey = "all" | "read" | "unread" | "gated";
type SortKey = "level" | "tasks" | "name";

const FILTERS: FilterKey[] = ["all", "read", "unread", "gated"];
const SORTS: SortKey[] = ["level", "tasks", "name"];

const copy = bilingual({
  en: {
    label: "Work",
    lead: "One row per kind of work; open a row to see the updates behind its level.",
    searchLabel: "Search kinds of work",
    searchPlaceholder: "a kind of work or a market…",
    filterLabel: "Show",
    filterAll: "All",
    filterRead: "Has evidence",
    filterUnread: "Nobody looked",
    filterGated: "Held by a non-technical condition",
    sortLabel: "Sort by",
    sortLevel: "Level",
    sortTasks: "Tasks",
    sortName: "Name",
    showing: "{shown} of {total} kinds of work",
    clear: "Clear filters",
    tasks: "{n|task|tasks}",
    open: "Open",
    close: "Close",
    market: "Market",
    noReading: "no update in the collected window mentions this work",
    gated: "Non-technical condition",
    gatedNote: "A non-technical condition does not lift when models improve; what it holds stays at L0.",
    readingsHead: "Evidence",
    judged: "Claimed",
    capped: "Capped by {tier}",
    kept: "Kept",
    source: "Source",
    emptyTitle: "Nothing matches.",
    emptyQuery: "No work here contains “{q}”.",
    emptyFilter: "No work in this occupation is in that state.",
    emptyWhy: "The filters describe what was collected, not what AI can do.",
  },
  "zh-CN": {
    label: "工作",
    lead: "一行一项工作；点开一行，看它的层级是哪几条更新给的。",
    searchLabel: "搜索工作",
    searchPlaceholder: "工作名或赛道名…",
    filterLabel: "显示",
    filterAll: "全部",
    filterRead: "有证据",
    filterUnread: "没人看过",
    filterGated: "受非技术门槛限制",
    sortLabel: "排序",
    sortLevel: "层级",
    sortTasks: "任务数",
    sortName: "名称",
    showing: "{total} 项工作中显示 {shown} 条",
    clear: "清除筛选",
    tasks: "项任务",
    open: "展开",
    close: "收起",
    market: "赛道",
    noReading: "采集窗口里没有一次更新谈到这项工作",
    gated: "非技术门槛",
    gatedNote: "非技术门槛不随模型变强而解除；受限的工作记在 L0。",
    readingsHead: "证据",
    judged: "判定",
    capped: "{tier} 封顶",
    kept: "采信",
    source: "来源",
    emptyTitle: "没有匹配的行。",
    emptyQuery: "这里没有工作包含「{q}」。",
    emptyFilter: "这个职业里没有处于该状态的工作。",
    emptyWhy: "筛选说的是采集到了什么，不是 AI 能做什么。",
  },
});

function levelText(level: number | null, levels: Record<string, string>): string | null {
  if (level === null || level === undefined) return null;
  const key = String(Math.floor(level));
  const word = levels[key];
  return word ? `L${key} · ${word}` : `L${key}`;
}

export function ActivityExplorer({
  activities,
  language,
  levels,
  tierCaps,
}: {
  activities: ExplorerActivity[];
  language: Language;
  /** The ladder's own words, from the snapshot. Never written in this file. */
  levels: Record<string, string>;
  /** What each kind of evidence is allowed to support. */
  tierCaps: Record<string, number>;
}) {
  const c = copy[language];
  const searchId = useId();
  const { ref, seen } = useSeen<HTMLDivElement>();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("level");
  const [open, setOpen] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const { frame, sentinel, count: visible } = useScrollPages(`${query}|${filter}|${sort}`);
  const touched = needle !== "" || filter !== "all";

  const shown = useMemo(() => {
    const kept = activities.filter((row) => {
      if (filter === "read" && row.readings.length === 0) return false;
      if (filter === "unread" && row.readings.length > 0) return false;
      if (filter === "gated" && !row.gated) return false;
      if (needle && !row.search.includes(needle)) return false;
      return true;
    });
    kept.sort((a, b) => {
      if (sort === "tasks") return b.tasks - a.tasks || byText(a.label, b.label);
      if (sort === "name") return a.label.localeCompare(b.label, language);
      return (b.level ?? -1) - (a.level ?? -1) || b.tasks - a.tasks || byText(a.id, b.id);
    });
    return kept;
  }, [activities, filter, needle, sort, language]);

  return (
    <div ref={ref} data-seen={seen ? "true" : undefined}>
      <Head label={c.label} tag={`${activities.length}`} tone="plain" />
      <p className={s.lead}>{c.lead}</p>

      <div className={s.controls}>
        <div className={s.searchField}>
          <label className={s.controlLabel} htmlFor={searchId}>
            {c.searchLabel}
          </label>
          <input
            id={searchId}
            className={s.input}
            type="search"
            value={query}
            autoComplete="off"
            placeholder={c.searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <fieldset className={s.chipField}>
          <legend className={s.controlLabel}>{c.filterLabel}</legend>
          <div className={s.chips}>
            {FILTERS.map((key) => (
              <button
                key={key}
                type="button"
                className={s.chip}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {key === "all"
                  ? c.filterAll
                  : key === "read"
                    ? c.filterRead
                    : key === "unread"
                      ? c.filterUnread
                      : c.filterGated}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className={s.chipField}>
          <legend className={s.controlLabel}>{c.sortLabel}</legend>
          <div className={s.chips}>
            {SORTS.map((key) => (
              <button
                key={key}
                type="button"
                className={s.chip}
                aria-pressed={sort === key}
                onClick={() => setSort(key)}
              >
                {key === "level" ? c.sortLevel : key === "tasks" ? c.sortTasks : c.sortName}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <p className={s.status} role="status">
        <span className={s.statusCount}>
          {c.showing
            .replace("{shown}", String(shown.length))
            .replace("{total}", String(activities.length))}
        </span>
        {touched ? (
          <button
            type="button"
            className={s.clear}
            onClick={() => {
              setQuery("");
              setFilter("all");
            }}
          >
            {c.clear}
          </button>
        ) : null}
      </p>

      {shown.length === 0 ? (
        <div className={s.empty}>
          <p className={s.emptyTitle}>{c.emptyTitle}</p>
          <p className={s.emptyWhy}>
            {needle ? c.emptyQuery.replace("{q}", query.trim()) : c.emptyFilter}
          </p>
          <p className={s.emptyWhy}>{c.emptyWhy}</p>
        </div>
      ) : (
        <div ref={frame} className="oaw-scroll">
        <ul className={s.rows}>
          {shown.slice(0, visible).map((row) => {
            const expanded = open === row.id;
            const word = levelText(row.level, levels);
            return (
              <li
                key={row.id}
                className={`${s.item}${expanded ? ` ${s.itemOpen}` : ""}`}
              >
                <button
                  type="button"
                  className={s.rowButton}
                  aria-expanded={expanded}
                  aria-controls={`${searchId}-${row.id}`}
                  onClick={() => setOpen(expanded ? null : row.id)}
                >
                  <span className={s.rowName}>
                    <span className={s.rowLabel}>{row.label}</span>
                    <span className={s.rowMarket}>{row.marketLabel}</span>
                  </span>
                  <span className={s.rowMeter}>
                    {row.level === null ? null : <Bar share={row.level / 5} />}
                  </span>
                  <span className={s.rowLevel}>
                    {word ?? <Blank reason={c.noReading} />}
                  </span>
                  <span className={s.rowTasks}>
                    {row.tasks}
                    <span className={s.unit}> {plural(c.tasks, { n: row.tasks })}</span>
                  </span>
                  <span className={s.rowToggle} aria-hidden="true">
                    {expanded ? "−" : "+"}
                  </span>
                </button>

                <div
                  id={`${searchId}-${row.id}`}
                  className={s.panel}
                  hidden={!expanded}
                >
                  <p className={s.panelMeta}>
                    <Link className={s.panelLink} href={href(language, `/markets/${row.marketSlug}`)}>
                      {c.market}: {row.marketLabel}
                    </Link>
                    {row.gated ? <span className={s.gateMark}>{c.gated}</span> : null}
                  </p>
                  {row.gated ? <p className={s.panelNote}>{c.gatedNote}</p> : null}

                  {row.readings.length === 0 ? (
                    <p className={s.panelNote}>{c.noReading}</p>
                  ) : (
                    <ol className={s.readings}>
                      {row.readings.map((reading) => {
                        const cap = tierCaps[reading.tier];
                        const cut =
                          reading.observed !== null &&
                          reading.level !== null &&
                          reading.observed > reading.level;
                        return (
                          <li key={`${reading.eventId}-${row.id}`} className={s.reading}>
                            <span className={s.readingDate}>
                              {reading.date ? reading.date.slice(0, 10) : "—"}
                            </span>
                            <span className={s.readingBody}>
                              <span className={s.readingTitle}>{reading.title}</span>
                              <span className={s.readingNumbers}>
                                {reading.org ? (
                                  <span className={s.readingOrg}>{reading.org}</span>
                                ) : null}
                                <span>
                                  {c.judged} {reading.observed == null ? "—" : `L${reading.observed}`}
                                </span>
                                <span className={cut ? s.readingCut : undefined}>
                                  {c.kept} {reading.level == null ? "—" : `L${reading.level}`}
                                </span>
                                <span className={s.readingTier}>
                                  {cap === undefined
                                    ? reading.tier
                                    : `${c.capped.replace("{tier}", reading.tier)} ≤ L${cap}`}
                                </span>
                                {reading.url ? (
                                  <a
                                    className={s.readingSource}
                                    href={reading.url}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                  >
                                    {c.source} ↗
                                  </a>
                                ) : null}
                              </span>
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {shown.length > visible ? <div ref={sentinel} className="oaw-scroll-end" /> : null}
        </div>
      )}
    </div>
  );
}
