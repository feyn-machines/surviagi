"use client";

import { useMemo, useState } from "react";
import { Blank, Head } from "@/components/blueprint";
import { ProgressCompare, finishedShare, type CompareRow } from "@/components/progress-compare";
import { useSeen } from "@/components/home/reveal";
import { bilingual, type Language } from "@/lib/i18n";
import { byText } from "@/lib/order";
import s from "./group.module.css";

/**
 * The spread inside one sector, not the sector's average.
 *
 * A sector reported as "10%" hides that one occupation inside it is at 47% and
 * most of the rest are at nothing. The gap between the two ends is the finding
 * this page exists for, so both ends are named above the ranking.
 *
 * Both ends are occupations something was actually read about. An occupation no
 * update mentions also sits at 0, but that 0 is about the collection; calling it
 * the narrowest would turn a gap in the reading into a claim about the job.
 */

export type MemberRow = CompareRow<`/occupations/${string}`> & {
  /** Tasks carrying a level at all. Zero means nobody has looked. */
  assessed: number;
};

type SortKey = "share" | "tasks" | "name";

const SORTS: SortKey[] = ["share", "tasks", "name"];

const copy = bilingual({
  en: {
    label: "Occupations",
    lead: "The same hundred squares, once per occupation, ranked.",
    sortLabel: "Sort by",
    sortShare: "Share",
    sortTasks: "Tasks",
    sortName: "Name",
    marksLabel: "Widest and narrowest",
    top: "Widest",
    bottom: "Narrowest",
    spread: "{n} points apart",
    flat: "Both ends read the same.",
    unread: "{n} more have no evidence at all.",
    blank: "no update in the collected window mentions this occupation",
  },
  "zh-CN": {
    label: "职业",
    lead: "同样的一百格，每个职业画一遍，按占比排名。",
    sortLabel: "排序",
    sortShare: "占比",
    sortTasks: "任务数",
    sortName: "名称",
    marksLabel: "最高与最低",
    top: "最高",
    bottom: "最低",
    spread: "相差 {n} 个百分点",
    flat: "两端的证据一样。",
    unread: "另有 {n} 个职业一条证据都没有。",
    blank: "采集窗口里没有一次更新谈到这个职业",
  },
});

export function MemberRanking({
  rows,
  language,
}: {
  rows: MemberRow[];
  language: Language;
}) {
  const c = copy[language];
  const [sort, setSort] = useState<SortKey>("share");
  const { ref, seen } = useSeen<HTMLDivElement>();

  const shares = useMemo(
    () => new Map(rows.map((row) => [row.id, finishedShare(row.counts, row.tasks)])),
    [rows],
  );

  const ordered = useMemo(() => {
    const next = [...rows];
    next.sort((a, b) => {
      if (sort === "tasks") return b.tasks - a.tasks || byText(a.label, b.label);
      if (sort === "name") return a.label.localeCompare(b.label, language);
      return (shares.get(b.id) ?? 0) - (shares.get(a.id) ?? 0) || byText(a.label, b.label);
    });
    return next;
  }, [rows, sort, shares, language]);

  const measured = useMemo(
    () =>
      rows
        .filter((row) => row.assessed > 0)
        .sort((a, b) => (shares.get(b.id) ?? 0) - (shares.get(a.id) ?? 0) || byText(a.label, b.label)),
    [rows, shares],
  );
  const top = measured[0];
  const bottom = measured[measured.length - 1];
  const spread = top && bottom ? (shares.get(top.id) ?? 0) - (shares.get(bottom.id) ?? 0) : 0;
  const unread = rows.length - measured.length;

  return (
    <div ref={ref} data-seen={seen ? "true" : undefined}>
      <Head label={c.label} tag={`${rows.length}`} tone="plain" />
      <p className={s.lead}>{c.lead}</p>

      {top && bottom ? (
        <ul className={s.extremes} aria-label={c.marksLabel}>
          <li className={s.extreme}>
            <span className={s.extremeLabel}>{c.top}</span>
            <span className={s.extremeName}>{top.label}</span>
            <span className={s.extremeValue}>
              {shares.get(top.id) ?? 0}
              <span className={s.pct}>%</span>
            </span>
          </li>
          <li className={s.extreme}>
            <span className={s.extremeLabel}>{c.bottom}</span>
            <span className={s.extremeName}>{bottom.label}</span>
            <span className={s.extremeValue}>
              {shares.get(bottom.id) ?? 0}
              <span className={s.pct}>%</span>
            </span>
          </li>
          <li className={s.extremeNote}>
            {spread === 0 ? c.flat : c.spread.replace("{n}", String(spread))}
            {unread > 0 ? (
              <span className={s.extremeUnread}>
                {" "}
                <Blank reason={c.blank} /> {c.unread.replace("{n}", String(unread))}
              </span>
            ) : null}
          </li>
        </ul>
      ) : null}

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

      {/* No `mark` here. Marking two rows dims the other thirty-four, and a
          ranking nobody can read is a worse trade than the highlight is worth;
          the two ends are named in full above. */}
      <div className="oaw-scroll" style={{ padding: "0 20px" }}>
        <ProgressCompare rows={ordered} language={language} order="given" />
      </div>
    </div>
  );
}
