import { plural } from "@/lib/plural";
import type { Route } from "next";
import Link from "next/link";
import type { Language } from "@/lib/i18n";
import { apportion, DRAW_ORDER, STAGE_KEYS, type StageKey, type WorkGridCounts } from "./work-grid-shape";
import s from "./progress-compare.module.css";

/**
 * Small multiples: the same 100 squares, once per sector, stacked and aligned.
 *
 * One grid on its own answers "how far". Twenty-two of them sharing a left edge
 * answer "how far compared with what", which is the question somebody deciding
 * where to put their effort actually has. Cells run most-autonomous first, so
 * each row reads as a frontier and the stack reads as a gradient.
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
    colSector: "Sector",
    colFrontier: "L5 ← 4 ← 3 ← 2 ← 1 ← 0 ← unknown ← untouched",
    colShare: "L2+",
    tasks: "{n|task|tasks}",
    median: "median",
    shareNote: "share of tasks AI produces the bulk of, leaving a person to check",
  },
  "zh-CN": {
    colSector: "领域",
    colFrontier: "L5 ← 4 ← 3 ← 2 ← 1 ← 0 ← 未知 ← 未触及",
    colShare: "L2 以上",
    tasks: "项任务",
    median: "中位",
    shareNote: "AI 出主体、人只做复核的任务占比",
  },
} as const;

/** L2 is where a person stops doing the work and starts checking it. */
function finishedShare(counts: WorkGridCounts, tasks: number) {
  if (!tasks) return 0;
  const atOrAbove = (["2", "3", "4", "5"] as const)
    .reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  return Math.round((atOrAbove / tasks) * 100);
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
  /** `given` keeps the caller's order; the default ranks by how far AI got. */
  order?: "share" | "given";
}) {
  const c = COPY[language];
  const ranked = order === "given"
    ? rows
    : [...rows].sort(
        (a, b) => finishedShare(b.counts, b.tasks) - finishedShare(a.counts, a.tasks),
      );
  const shares = ranked.map((row) => finishedShare(row.counts, row.tasks));
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
          const share = finishedShare(row.counts, row.tasks);
          const drawn = apportion(row.counts, 100);
          const cells: StageKey[] = [];
          // The same order the single grid uses; a second copy is how two
          // charts of the same data quietly stop being comparable.
          for (const key of DRAW_ORDER) {
            for (let i = 0; i < drawn[key]; i += 1) cells.push(key);
          }
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
                  <span key={i} className={`${s.cell} ${s[`stage${key}`]}`} />
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

export { finishedShare, STAGE_KEYS };
