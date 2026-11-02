/**
 * The shape of the hundred-square grid, with no data source attached.
 *
 * Split out of work-grid.tsx so a client component that wants only `apportion`
 * or `DRAW_ORDER` does not have to import a server component. Importing the
 * snapshot reader from the browser used to drag
 * `node:fs` into the browser bundle through that import, which fails the build
 * with an error naming the chunker rather than the import that caused it.
 *
 * Everything here is pure: same input, same squares, no I/O.
 */

/** Touched: at least one collected update bears on the work. Untouched: none does. */
export type StageKey = "touched" | "untouched";

export const STAGE_KEYS: StageKey[] = ["touched", "untouched"];

/** What has been touched first: the eye lands on how far the reading got, then reads down. */
export const DRAW_ORDER: StageKey[] = ["touched", "untouched"];

export type WorkGridCounts = Partial<Record<StageKey, number>>;

/**
 * The published per-task counts folded into the two states drawn here.
 *
 * A task covered only by work no update speaks of is untouched like one nothing
 * covers: both mean no collected update reaches it, and that says something
 * about the collection, not about the job.
 */
export function gridCounts(by: Partial<Record<string, number>>): WorkGridCounts {
  const touched = (["0", "1", "2", "3", "4", "5"] as const).reduce((sum, key) => sum + (by[key] ?? 0), 0);
  return { touched, untouched: (by.unknown ?? 0) + (by.untouched ?? 0) };
}

/**
 * Largest remainder, so the squares always total exactly `squares`.
 *
 * Rounding each share on its own happens to land on 100 for today's numbers and
 * would silently produce 99 or 101 for tomorrow's. The chart must not depend on
 * that luck.
 */
export function apportion(counts: WorkGridCounts, squares: number): Record<StageKey, number> {
  const total = STAGE_KEYS.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  const out = Object.fromEntries(STAGE_KEYS.map((k) => [k, 0])) as Record<StageKey, number>;
  if (total <= 0) return out;

  const exact = STAGE_KEYS.map((key) => ((counts[key] ?? 0) / total) * squares);
  const floors = exact.map(Math.floor);
  let remaining = squares - floors.reduce((a, b) => a + b, 0);

  const order = STAGE_KEYS.map((key, i) => ({ key, i, frac: exact[i] - floors[i] }))
    // A tie goes to the larger bucket, so the order never depends on key order.
    .sort((a, b) => b.frac - a.frac || (counts[b.key] ?? 0) - (counts[a.key] ?? 0));

  STAGE_KEYS.forEach((key, i) => { out[key] = floors[i]; });
  for (const entry of order) {
    if (remaining <= 0) break;
    out[entry.key] += 1;
    remaining -= 1;
  }
  return out;
}

/** The cells to draw, in DRAW_ORDER, always a hundred of them. */
export function cellsFor(counts: WorkGridCounts, squares = 100): StageKey[] {
  const drawn = apportion(counts, squares);
  const cells: StageKey[] = [];
  for (const key of DRAW_ORDER) {
    for (let i = 0; i < drawn[key]; i += 1) cells.push(key);
  }
  return cells;
}
