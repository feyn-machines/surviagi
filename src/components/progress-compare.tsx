import { plural } from "@/lib/plural";
import type { Route } from "next";
import Link from "next/link";
import type { Language } from "@/lib/i18n";
import { cellsFor, STAGE_KEYS, type WorkGridCounts } from "./work-grid-shape";
import s from "./progress-compare.module.css";

/**
 * Small multiples: the same 100 squares, once per sector, stacked and aligned.
 *
 * One grid on its own answers "how far". Twenty-two of them sharing a left edge
 * answer "how far compared with what", which is the question somebody deciding
 * where to look first actually has. Touched cells run first, so each row reads
 * as a bar and the stack reads as a gradient.
 *
 * Alignment is the whole technique: same cell size, same start, same order,
 * sorted once. Break any of those and the rows stop being comparable.
 */

/**
 * `href` is a `Route`, so a bare string cannot be passed: a row's link is built
 * with `href()` or an entity helper from `@/lib/routes`, which checks the path
 * against the route tree and carries the reader's language. Three hrefs in this
 * repo once pointed at routes that had been deleted; casting with `as Route` at
 * the call site would wave that rot through again.
 */
export type CompareRow<T extends string = string> = {
  id: string;
  label: string;
  tasks: number;
  counts: WorkGridCounts;
  href?: Route<T>;
};

const COLUMNS = 25;

const COPY = {
  en: {
    colSector: "Name",
    colFrontier: "touched ← not touched",
    colShare: "Touched",
    tasks: "{n|task|tasks}",
    median: "median",
    shareNote: "share of tasks at least one collected update bears on",
  },
  "zh-CN": {
    colSector: "名称",
    colFrontier: "已触及 ← 未触及",
    colShare: "已触及",
    tasks: "项任务",
    median: "中位",
    shareNote: "至少有一条采集到的更新谈到的任务比例",
  },
} as const;

/** Share of tasks an update has touched, as a whole percent. */
function touchedShareOf(counts: WorkGridCounts, tasks: number) {
  if (!tasks) return 0;
  return Math.round(((counts.touched ?? 0) / tasks) * 100);
}

export function ProgressCompare<T extends string>({
  rows,
  language,
  mark,
  order = "share",
}: {
  rows: CompareRow<T>[];
  language: Language;
  /**
   * Rows to pick out. The others are dimmed, but dimming is not the only
   * signal: a marked row also gets a filled square at its head, because colour
   * alone must never be the thing carrying the information.
   */
  mark?: Set<string>;
  /** `given` keeps the caller's order; the default ranks by how much is touched. */
  order?: "share" | "given";
}) {
  const c = COPY[language];
  const ranked = order === "given"
    ? rows
    : [...rows].sort(
        (a, b) => touchedShareOf(b.counts, b.tasks) - touchedShareOf(a.counts, a.tasks),
      );
  const shares = ranked.map((row) => touchedShareOf(row.counts, row.tasks));
  const median = shares.length
    ? shares.slice().sort((x, y) => x - y)[Math.floor(shares.length / 2)]
    : 0;

  return (
    <div className={s.wrap}>
      <div className={`${s.row} ${s.head}`} aria-hidden="true">
        <span className={s.label}>{c.colSector}</span>
        <span className={s.frontierHead}>{c.colFrontier}</span>
        <span className={s.share}>{c.colShare}</span>
      </div>

      <ol className={s.list}>
        {ranked.map((row) => {
          const share = touchedShareOf(row.counts, row.tasks);
          const cells = cellsFor(row.counts);
          const marked = mark ? mark.has(row.id) : false;
          const body = (
            <>
              <span className={s.label}>
                {marked ? <span className={s.markDot} aria-hidden="true" /> : null}
                {row.label}
                <span className={s.sub}>
                  {new Intl.NumberFormat("en-US").format(row.tasks)} {plural(c.tasks, { n: row.tasks })}
                </span>
              </span>
              <span
                className={s.frontier}
                style={{ gridTemplateColumns: `repeat(${COLUMNS}, 1fr)` }}
              >
                {cells.map((key, i) => (
                  <span key={i} className={`${s.cell} ${s[key]}`} />
                ))}
              </span>
              <span className={s.share}>
                {share}
                <span className={s.pct}>%</span>
              </span>
            </>
          );
          return (
            <li
              key={row.id}
              className={`${s.item}${mark && !marked ? ` ${s.dim}` : ""}`}
            >
              {row.href ? (
                <Link className={s.row} href={row.href}>
                  {body}
                </Link>
              ) : (
                <span className={s.row}>{body}</span>
              )}
            </li>
          );
        })}
      </ol>

      <p className={s.footnote}>
        {c.median} {median}% · {c.shareNote}
      </p>
    </div>
  );
}

export { touchedShareOf, STAGE_KEYS };
