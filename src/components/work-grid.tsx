import type { Language } from "@/lib/i18n";
import { progress } from "@/lib/snapshot";
import {
  DRAW_ORDER,
  STAGE_KEYS,
  apportion,
  cellsFor,
  type StageKey,
  type WorkGridCounts,
} from "./work-grid-shape";

// Re-exported so existing importers keep one name for the grid. The shapes
// themselves live in work-grid-shape.ts, which opens no files and can
// therefore be imported from a client component.
export { DRAW_ORDER, STAGE_KEYS, apportion, cellsFor };
export type { StageKey, WorkGridCounts };
import s from "./work-grid.module.css";

/**
 * One square, one piece of work.
 *
 * A square is filled to the LOWEST level among the activities that cover that
 * work item, because a task needs all of its work done: AI failing at any part
 * means the task is not done. Taking the highest is what once put baggage
 * porters at 59% — greeting guests matched, carrying the bags did not.
 *
 * Two kinds of blank, and they are different findings. `unknown` is covered by
 * an activity that has no evidence behind it, so the minimum cannot be known.
 * `untouched` is covered by nothing at all. Merging them draws "AI cannot do
 * this" over work nobody has looked at, which is the opposite of what is known.
 *
 * Always a hundred squares, whatever is being drawn. Equal length is what makes
 * two grids comparable, and it is the only thing that has to hold: exact task
 * counts still appear as numbers beside the chart, so drawing them as cells as
 * well bought nothing and cost a second way of reading the same picture.
 */

/**
 * The site carries no ladder text of its own.
 *
 * L0-L5 names and sentences come from the published snapshot, which projects
 * them out of the activity_level vocabulary. A component holding its own copy
 * of "AI produces the bulk, a person checks every item" is the type layer
 * duplicated into the rendering layer: it reads correctly right up until the
 * vocabulary is edited, and then the chart and the method disagree with no
 * error anywhere. `pnpm ontology:check` fails if that text comes back here.
 *
 * `unknown` and `untouched` DO belong here. They are not rungs of the ladder -
 * they are what the publisher records when there is no reading to place on it -
 * and the sentence explaining each is this site's own editorial.
 */
const COPY = {
  en: {
    unknown: "Unknown",
    unknownNote: "part of this work has no evidence either way",
    untouched: "Untouched",
    untouchedNote: "no update in the collected window mentions it",
    ofTotal: "of {total}",
    empty: "empty",
    textTitle: "The same grid as text",
  },
  "zh-CN": {
    unknown: "未知",
    unknownNote: "这项工作里有一环没有任何方向的证据",
    untouched: "未触及",
    untouchedNote: "采集窗口里没有一次更新谈到它",
    ofTotal: "共 {total}",
    empty: "空",
    textTitle: "同一张图的文字版",
  },
} as const;

function stageLabel(key: StageKey, language: Language) {
  if (key === "unknown" || key === "untouched") return COPY[language][key];
  const word = progress()?.levels?.[key]?.[language];
  // A rung with no published label still has to draw: the number alone is the
  // honest fallback, never an invented name for it.
  return word ? `L${key} · ${word}` : `L${key}`;
}

function stageNote(key: StageKey, language: Language) {
  const c = COPY[language];
  if (key === "unknown") return c.unknownNote;
  if (key === "untouched") return c.untouchedNote;
  return progress()?.level_definitions?.[key]?.[language] ?? null;
}

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
          <span key={i} className={`${s.cell} ${s[`stage${key}`]}`} aria-hidden="true" />
        ))}
      </div>

      <p className={s.scaleNote}>{c.ofTotal.replace("{total}", formatNumber(total))}</p>

      {/* The legend is not decoration: L5 has no squares anywhere, and "no work
          runs with nobody" is the most important line on the chart. A bucket
          with no cells would otherwise simply not appear. */}
      <figcaption className={s.legend}>
        <span className={s.legendTitle}>{c.textTitle}</span>
        <ul className={s.legendList}>
          {DRAW_ORDER.map((key) => {
            const n = counts[key] ?? 0;
            const note = stageNote(key, language);
            return (
              <li key={key} className={n === 0 ? s.legendEmpty : undefined}>
                <span className={`${s.swatch} ${s[`stage${key}`]}`} aria-hidden="true" />
                <span className={s.legendLabel}>{stageLabel(key, language)}</span>
                <span className={s.legendValue}>
                  {n === 0 ? c.empty : formatNumber(n)}
                </span>
                {note ? <span className={s.legendNote}>{note}</span> : null}
              </li>
            );
          })}
        </ul>
      </figcaption>
    </figure>
  );
}
