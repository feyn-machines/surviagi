import type { Language } from "@/lib/i18n";
import {
  DRAW_ORDER,
  STAGE_KEYS,
  apportion,
  cellsFor,
  gridCounts,
  type StageKey,
  type WorkGridCounts,
} from "./work-grid-shape";

// Re-exported so existing importers keep one name for the grid. The shapes
// themselves live in work-grid-shape.ts, which opens no files and can
// therefore be imported from a client component.
export { DRAW_ORDER, STAGE_KEYS, apportion, cellsFor, gridCounts };
export type { StageKey, WorkGridCounts };
import s from "./work-grid.module.css";

/**
 * One square, one piece of work.
 *
 * A square is filled when at least one collected update bears on that work, and
 * left empty when none does. Nothing is graded: an empty square is a statement
 * about the collection, not about whether AI can do the job.
 *
 * Always a hundred squares, whatever is being drawn. Equal length is what makes
 * two grids comparable, and it is the only thing that has to hold: exact task
 * counts still appear as numbers beside the chart, so drawing them as cells as
 * well bought nothing and cost a second way of reading the same picture.
 */
const COPY = {
  en: {
    touched: "Touched",
    touchedNote: "at least one collected update bears on it",
    untouched: "Not touched",
    untouchedNote: "no update in the collected window mentions it",
    ofTotal: "of {total}",
    empty: "empty",
    textTitle: "The same grid as text",
  },
  "zh-CN": {
    touched: "已触及",
    touchedNote: "至少有一条采集到的更新谈到它",
    untouched: "未触及",
    untouchedNote: "采集窗口里没有一次更新谈到它",
    ofTotal: "共 {total}",
    empty: "空",
    textTitle: "同一张图的文字版",
  },
} as const;

function formatNumber(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

export function WorkGrid({
  counts,
  language,
  columns = 10,
  title,
}: {
  counts: WorkGridCounts;
  language: Language;
  columns?: number;
  title: string;
}) {
  const c = COPY[language];
  const total = STAGE_KEYS.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  const cells = cellsFor(counts);

  return (
    <figure className={s.figure}>
      <div
        className={s.grid}
        style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        role="img"
        aria-label={title}
      >
        {cells.map((key, i) => (
          <span key={i} className={`${s.cell} ${s[key]}`} aria-hidden="true" />
        ))}
      </div>

      <p className={s.scaleNote}>{c.ofTotal.replace("{total}", formatNumber(total))}</p>

      {/* The legend is not decoration: a bucket with no cells would otherwise
          simply not appear, and "nothing touched" is a finding. */}
      <figcaption className={s.legend}>
        <span className={s.legendTitle}>{c.textTitle}</span>
        <ul className={s.legendList}>
          {DRAW_ORDER.map((key) => {
            const n = counts[key] ?? 0;
            return (
              <li key={key}>
                <span className={`${s.swatch} ${s[key]}`} aria-hidden="true" />
                <span className={s.legendLabel}>{c[key]}</span>
                <span className={s.legendValue}>
                  {n === 0 ? c.empty : formatNumber(n)}
                </span>
                <span className={s.legendNote}>{c[`${key}Note`]}</span>
              </li>
            );
          })}
        </ul>
      </figcaption>
    </figure>
  );
}
