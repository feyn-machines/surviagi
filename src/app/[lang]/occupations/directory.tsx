"use client";

import { useId, useMemo, useState } from "react";
import { Picker } from "@/components/picker";
import { useScrollPages } from "@/components/scroll-pages";
import Link from "next/link";
import { Bar, Blank, Head } from "@/components/blueprint";
import { useSeen } from "@/components/home/reveal";
import { bilingual, type Language } from "@/lib/i18n";
import { href } from "@/lib/routes";
import { byText } from "@/lib/order";
import s from "./occupations.module.css";

/**
 * Nine hundred occupations, and the reader wants exactly one of them.
 *
 * So the search box is the page, not an ornament beside it: it filters as you
 * type, over both languages at once, because the Chinese label is a translation
 * of a source name a reader may well know in English. Everything else - the
 * distribution, the group and reading filters, the sort - exists to answer the
 * question a reader asks the moment they have found their own row: is this
 * number normal?
 *
 * The whole list is rendered on the server and is complete with JavaScript off.
 * Nothing here gates content; it only narrows it.
 */

export type DirectoryRow = {
  id: string;
  /** `/occupations/<slug>` - the link that must survive any filtering. */
  slug: string;
  label: string;
  /** Both languages, lowercased, so an English search finds a Chinese row. */
  search: string;
  groupId: string;
  tasks: number;
  /** Rounded share of this occupation's tasks at L2 or above. */
  share: number;
  /** Tasks carrying any level at all. Zero means nobody has looked. */
  assessed: number;
};

export type DirectoryGroup = {
  id: string;
  slug: string;
  label: string;
  tasks: number;
  share: number;
};

type SortKey = "share" | "tasks" | "name";
type ReadKey = "all" | "read" | "unread";

const SORTS: SortKey[] = ["share", "tasks", "name"];
const READS: ReadKey[] = ["all", "read", "unread"];

/** Where a share falls. Index 0 is a measured zero and stays its own band. */
const BANDS = [0, 1, 10, 20, 30, 40] as const;

export function bandOf(share: number): number {
  if (share <= 0) return 0;
  if (share < 10) return 1;
  if (share < 20) return 2;
  if (share < 30) return 3;
  if (share < 40) return 4;
  return 5;
}

const copy = bilingual({
  en: {
    distLabel: "Distribution",
    distLead: "Where the 923 occupations fall.",
    bandZero: "0%",
    band1: "1-9%",
    band2: "10-19%",
    band3: "20-29%",
    band4: "30-39%",
    band5: "40%+",
    bandUnit: "occupations",
    searchLabel: "Search by job title",
    searchPlaceholder: "teacher, 会计, machinist…",
    groupLabel: "Occupation group",
    groupAll: "All 23 groups",
    sortLabel: "Sort by",
    sortShare: "Share",
    sortTasks: "Tasks",
    sortName: "Name",
    readLabel: "Evidence",
    readAll: "All",
    readRead: "Has evidence",
    readUnread: "Nobody looked",
    showing: "{shown} of {total} occupations",
    filtered: "filtered",
    clear: "Clear filters",
    controls: "Find your occupation",
    colTasks: "tasks",
    colShare: "L2+",
    shareNote: "L2+ is the share of an occupation's tasks at L2 or above. L2 reads: {l2}",
    emptyTitle: "Nothing matches.",
    emptyQuery: "No job title contains “{q}”.",
    emptyRead: "Every occupation in this group has been left unread.",
    emptyBand: "No occupation in this selection falls in that band.",
    emptyWhy: "Titles come from the source taxonomy, so try a shorter word or the other language.",
    blank: "no update in the collected window mentions this occupation",
    openGroup: "Open group",
    groupEmpty: "The source publishes no task statement for this group.",
  },
  "zh-CN": {
    distLabel: "分布",
    distLead: "923 个职业各自落在哪一档。",
    bandZero: "0%",
    band1: "1-9%",
    band2: "10-19%",
    band3: "20-29%",
    band4: "30-39%",
    band5: "40% 以上",
    bandUnit: "个职业",
    searchLabel: "按职业名搜索",
    searchPlaceholder: "教师、会计、machinist…",
    groupLabel: "职业组",
    groupAll: "全部 23 组",
    sortLabel: "排序",
    sortShare: "占比",
    sortTasks: "任务数",
    sortName: "名称",
    readLabel: "证据",
    readAll: "全部",
    readRead: "有证据",
    readUnread: "没人看过",
    showing: "{total} 个职业中显示 {shown} 个",
    filtered: "已筛选",
    clear: "清除筛选",
    controls: "找到你自己的职业",
    colTasks: "项任务",
    colShare: "L2 以上",
    shareNote: "L2 以上 = 该职业任务里到 L2 及以上的占比。L2 是：{l2}",
    emptyTitle: "没有匹配的行。",
    emptyQuery: "没有职业名包含「{q}」。",
    emptyRead: "这一组里的职业全都没人看过。",
    emptyBand: "当前选择里没有职业落在这一档。",
    emptyWhy: "职业名来自来源分类，换个更短的词或换一种语言再试。",
    blank: "采集窗口里没有一次更新谈到这个职业",
    openGroup: "打开职业组",
    groupEmpty: "来源没有为这一组发布任何任务语句。",
  },
});

function bandLabel(band: number, c: Record<string, string>): string {
  return [c.bandZero, c.band1, c.band2, c.band3, c.band4, c.band5][band];
}

export function OccupationDirectory({
  rows,
  groups,
  language,
  l2Word,
}: {
  rows: DirectoryRow[];
  groups: DirectoryGroup[];
  language: Language;
  /** The L2 rung's own word, read from the snapshot. Never written here. */
  l2Word: string;
}) {
  const c = copy[language];
  const searchId = useId();
  const { ref, seen } = useSeen<HTMLDivElement>();

  const [query, setQuery] = useState("");
  // One group at a time: the page opens on the group furthest along, and a search looks through all of them.
  const first = useMemo(() => [...groups].sort((a, b) => b.share - a.share)[0]?.id ?? "", [groups]);
  const [group, setGroup] = useState(first);
  const [sort, setSort] = useState<SortKey>("share");
  const [read, setRead] = useState<ReadKey>("all");
  const [band, setBand] = useState<number | null>(null);

  const needle = query.trim().toLowerCase();
  // A group is always chosen, so only the groups with rows to show are drawn.
  const touched = true;

  // The distribution is of the whole catalogue, always. A histogram that moved
  // with the filter would stop being the thing the reader compares against.
  const histogram = useMemo(() => {
    const counts = BANDS.map(() => 0);
    for (const row of rows) counts[bandOf(row.share)] += 1;
    const peak = Math.max(1, ...counts);
    return counts.map((n, i) => ({ band: i, n, share: n / peak }));
  }, [rows]);

  const shown = useMemo(() => {
    const kept = rows.filter((row) => {
      if (!needle && group && row.groupId !== group) return false;
      if (read === "read" && row.assessed === 0) return false;
      if (read === "unread" && row.assessed > 0) return false;
      if (band !== null && bandOf(row.share) !== band) return false;
      if (needle && !row.search.includes(needle)) return false;
      return true;
    });
    kept.sort((a, b) => {
      if (sort === "tasks") return b.tasks - a.tasks || byText(a.label, b.label);
      if (sort === "name") return a.label.localeCompare(b.label, language);
      return b.share - a.share || b.assessed - a.assessed || byText(a.label, b.label);
    });
    return kept;
  }, [rows, group, read, band, needle, sort, language]);

  // Sections keep every group link on the page; the filters narrow what is
  // inside them rather than removing the way to a group's own page.
  const sections = useMemo(() => {
    const byGroup = new Map<string, DirectoryRow[]>();
    for (const row of shown) {
      const found = byGroup.get(row.groupId);
      if (found) found.push(row);
      else byGroup.set(row.groupId, [row]);
    }
    // With nothing filtering, every group in the taxonomy is listed even when
    // the source publishes no task for it: twenty-two sections where the
    // taxonomy has twenty-three is a silent omission. Once a filter is on, a
    // wall of empty sections would bury the rows that did match.
    const ordered = groups
      .filter((g) => byGroup.has(g.id) || !touched)
      .sort((a, b) => {
        if (sort === "tasks") return b.tasks - a.tasks || byText(a.label, b.label);
        if (sort === "name") return a.label.localeCompare(b.label, language);
        return b.share - a.share || byText(a.label, b.label);
      });
    return ordered.map((g) => ({ group: g, members: byGroup.get(g.id) ?? [] }));
  }, [shown, groups, sort, touched, language]);

  const clear = () => {
    setQuery("");
    setGroup(first);
    setRead("all");
    setBand(null);
  };

  // The frame shows the list a page at a time; a group whose turn has not come is not drawn at all.
  const { frame, sentinel, count: visible } = useScrollPages(`${query}|${group}|${sort}|${read}|${band}`, 60);
  let budget = visible;
  const paged: { group: (typeof sections)[number]["group"]; members: (typeof sections)[number]["members"]; total: number }[] = [];
  for (const section of sections) {
    if (budget <= 0) break;
    paged.push({ group: section.group, members: section.members.slice(0, budget), total: section.members.length });
    budget -= Math.max(1, section.members.length);
  }
  const more = sections.reduce((n, section) => n + Math.max(1, section.members.length), 0) > visible;

  return (
    <div ref={ref} data-seen={seen ? "true" : undefined}>
      <section className={s.dist} aria-labelledby={`${searchId}-dist`}>
        <span id={`${searchId}-dist`} className="oaw-sr-only">
          {c.distLabel}
        </span>
        <Head label={c.distLabel} tag={`${rows.length} · ${c.bandUnit}`} tone="plain" />
        <p className={s.lead}>{c.distLead}</p>
        <ul className={s.bands}>
          {histogram.map((entry) => {
            const active = band === entry.band;
            return (
              <li key={entry.band} className={active ? s.bandActive : undefined}>
                <button
                  type="button"
                  className={s.bandRow}
                  aria-pressed={active}
                  onClick={() => setBand(active ? null : entry.band)}
                >
                  <span className={s.bandName}>{bandLabel(entry.band, c)}</span>
                  <span className={s.bandBar}>
                    <Bar
                      share={entry.share}
                      label={`${bandLabel(entry.band, c)} — ${entry.n}`}
                    />
                  </span>
                  <span className={s.bandCount}>{entry.n}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={s.controls} aria-label={c.controls}>
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

        <div className={s.selectField}>
          <Picker
            label={c.groupLabel}
            value={group}
            options={groups.map((g) => ({ value: g.id, label: g.label, note: `${g.share}%` }))}
            onChange={setGroup}
          />
        </div>

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
                {key === "share" ? c.sortShare : key === "tasks" ? c.sortTasks : c.sortName}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className={s.chipField}>
          <legend className={s.controlLabel}>{c.readLabel}</legend>
          <div className={s.chips}>
            {READS.map((key) => (
              <button
                key={key}
                type="button"
                className={s.chip}
                aria-pressed={read === key}
                onClick={() => setRead(key)}
              >
                {key === "all" ? c.readAll : key === "read" ? c.readRead : c.readUnread}
              </button>
            ))}
          </div>
        </fieldset>
      </section>

      <p className={s.status} role="status">
        <span className={s.statusCount}>
          {c.showing
            .replace("{shown}", String(shown.length))
            .replace("{total}", String(rows.length))}
        </span>
        {needle !== "" || group !== first || read !== "all" || band !== null ? (
          <button type="button" className={s.clear} onClick={clear}>
            {c.clear}
          </button>
        ) : null}
      </p>

      {sections.length === 0 ? (
        <div className={s.empty}>
          <p className={s.emptyTitle}>{c.emptyTitle}</p>
          <p className={s.emptyWhy}>
            {needle
              ? c.emptyQuery.replace("{q}", query.trim())
              : band !== null
                ? c.emptyBand
                : c.emptyRead}
          </p>
          <p className={s.emptyWhy}>{c.emptyWhy}</p>
        </div>
      ) : (
        <div ref={frame} className={`oaw-scroll ${s.frame}`}>
        {paged.map(({ group: g, members, total }) => (
          <section key={g.id} className={s.group} id={`g${g.slug}`}>
            <Link
              className={s.groupLink}
              href={href(language, `/occupations/g/${g.slug}`)}
              aria-label={`${c.openGroup}: ${g.label}`}
            >
              <Head
                label={g.label}
                tag={`${total} · ${g.share}%`}
                tone={g.share > 0 ? "signal" : "plain"}
              />
            </Link>
            {total === 0 ? (
              <p className={s.groupEmpty}>{c.groupEmpty}</p>
            ) : (
            <ul className={s.list}>
              {members.map((member) => (
                <li key={member.id} className={s.item}>
                  <Link className={s.row} href={href(language, `/occupations/${member.slug}`)}>
                    <span className={s.name}>{member.label}</span>
                    <span className={s.tasks}>
                      {member.tasks}
                      <span className={s.unit}> {c.colTasks}</span>
                    </span>
                    <span className={s.meter}>
                      {member.share > 0 ? <Bar share={member.share / 100} /> : null}
                    </span>
                    <span className={s.share}>
                      {member.assessed === 0 ? (
                        <Blank reason={c.blank} />
                      ) : (
                        <>
                          {member.share}
                          <span className={s.pct}>%</span>
                        </>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            )}
          </section>
        ))}
        {more ? <div ref={sentinel} className="oaw-scroll-end" /> : null}
        </div>
      )}

      <p className={s.footnote}>{c.shareNote.replace("{l2}", l2Word)}</p>
    </div>
  );
}
