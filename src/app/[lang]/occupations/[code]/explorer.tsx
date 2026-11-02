"use client";

import { plural } from "@/lib/plural";
import { useId, useMemo, useState } from "react";
import { useScrollPages } from "@/components/scroll-pages";
import type { Route } from "next";
import Link from "next/link";
import { Blank, Head } from "@/components/blueprint";
import { useSeen } from "@/components/home/reveal";
import { bilingual, type Language } from "@/lib/i18n";
import { href, updateHref } from "@/lib/routes";
import { byText } from "@/lib/order";
import s from "./detail.module.css";

/**
 * The work in this occupation, one kind of work a row, and every row opens onto
 * the collected updates that bear on it.
 *
 * Nothing here is graded. A row says how many updates mention the work and who
 * said it; a reader checks the claim in the original post, and the market page
 * the row links to lists the same updates beside the rest of that market.
 */

export type ExplorerUpdate = {
  key: string;
  /** Null for a post by someone else that also says so: recorded, not verified. */
  eventId: string | null;
  title: string;
  when: string | null;
  org: string | null;
  url: string | null;
};

export type ExplorerActivity = {
  id: string;
  label: string;
  search: string;
  marketLabel: string;
  marketSlug: string;
  /** The row on the market page. */
  href: Route;
  tasks: number;
  updates: ExplorerUpdate[];
};

type FilterKey = "all" | "read" | "unread";
type SortKey = "updates" | "tasks" | "name";

const FILTERS: FilterKey[] = ["all", "read", "unread"];
const SORTS: SortKey[] = ["updates", "tasks", "name"];

const copy = bilingual({
  en: {
    label: "Work",
    lead: "One row per kind of work; open a row to see the updates that bear on it.",
    searchLabel: "Search kinds of work",
    searchPlaceholder: "a kind of work or a market…",
    filterLabel: "Show",
    filterAll: "All",
    filterRead: "Has updates",
    filterUnread: "Nobody looked",
    sortLabel: "Sort by",
    sortUpdates: "Updates",
    sortTasks: "Tasks",
    sortName: "Name",
    showing: "{shown} of {total} kinds of work",
    clear: "Clear filters",
    tasks: "{n|task|tasks}",
    updatesUnit: "{n|update|updates}",
    market: "Market",
    onMarket: "Open on the market page",
    noUpdates: "no update in the collected window mentions this work",
    source: "Source",
    emptyTitle: "Nothing matches.",
    emptyQuery: "No work here contains “{q}”.",
    emptyFilter: "No work in this occupation is in that state.",
    emptyWhy: "The filters describe what was collected, not what AI can do.",
  },
  "zh-CN": {
    label: "工作",
    lead: "一行一项工作；点开一行，看谈到它的更新。",
    searchLabel: "搜索工作",
    searchPlaceholder: "工作名或赛道名…",
    filterLabel: "显示",
    filterAll: "全部",
    filterRead: "有更新",
    filterUnread: "没人看过",
    sortLabel: "排序",
    sortUpdates: "更新数",
    sortTasks: "任务数",
    sortName: "名称",
    showing: "{total} 项工作中显示 {shown} 条",
    clear: "清除筛选",
    tasks: "项任务",
    updatesUnit: "条更新",
    market: "赛道",
    onMarket: "在赛道页打开",
    noUpdates: "采集窗口里没有一次更新谈到这项工作",
    source: "来源",
    emptyTitle: "没有匹配的行。",
    emptyQuery: "这里没有工作包含「{q}」。",
    emptyFilter: "这个职业里没有处于该状态的工作。",
    emptyWhy: "筛选说的是采集到了什么，不是 AI 能做什么。",
  },
});

/** Updates by the company itself; posts by others that also say so are listed but not counted. */
function ownUpdates(row: ExplorerActivity) {
  return row.updates.filter((update) => update.eventId !== null).length;
}

export function ActivityExplorer({
  activities,
  language,
}: {
  activities: ExplorerActivity[];
  language: Language;
}) {
  const c = copy[language];
  const searchId = useId();
  const { ref, seen } = useSeen<HTMLDivElement>();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("updates");
  const [open, setOpen] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const { frame, sentinel, count: visible } = useScrollPages(`${query}|${filter}|${sort}`);
  const touched = needle !== "" || filter !== "all";

  const shown = useMemo(() => {
    const kept = activities.filter((row) => {
      if (filter === "read" && row.updates.length === 0) return false;
      if (filter === "unread" && row.updates.length > 0) return false;
      if (needle && !row.search.includes(needle)) return false;
      return true;
    });
    kept.sort((a, b) => {
      if (sort === "tasks") return b.tasks - a.tasks || byText(a.label, b.label);
      if (sort === "name") return a.label.localeCompare(b.label, language);
      return ownUpdates(b) - ownUpdates(a) || b.tasks - a.tasks || byText(a.id, b.id);
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
                {key === "all" ? c.filterAll : key === "read" ? c.filterRead : c.filterUnread}
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
                {key === "updates" ? c.sortUpdates : key === "tasks" ? c.sortTasks : c.sortName}
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
            const own = ownUpdates(row);
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
                  <span className={s.rowLevel}>
                    {own > 0 ? (
                      <>
                        {own} {plural(c.updatesUnit, { n: own })}
                      </>
                    ) : (
                      <Blank reason={c.noUpdates} />
                    )}
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
                    <Link className={s.panelLink} href={row.href}>
                      {c.onMarket}
                    </Link>
                  </p>

                  {row.updates.length === 0 ? (
                    <p className={s.panelNote}>{c.noUpdates}</p>
                  ) : (
                    <ol className={s.readings}>
                      {row.updates.map((update) => (
                        <li key={`${update.key}-${row.id}`} className={s.reading}>
                          <span className={s.readingDate}>{update.when ?? "—"}</span>
                          <span className={s.readingBody}>
                            <span className={s.readingTitle}>
                              {update.eventId ? (
                                <Link href={updateHref(language, update.eventId)}>{update.title}</Link>
                              ) : (
                                update.title
                              )}
                            </span>
                            <span className={s.readingNumbers}>
                              {update.org ? <span className={s.readingOrg}>{update.org}</span> : null}
                              {update.url ? (
                                <a
                                  className={s.readingSource}
                                  href={update.url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                >
                                  {c.source} ↗
                                </a>
                              ) : null}
                            </span>
                          </span>
                        </li>
                      ))}
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
