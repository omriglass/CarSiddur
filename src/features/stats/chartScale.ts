/**
 * Pure y-axis scale math for `WeeklyUnmetChart`'s inline-SVG bar chart
 * (UX_FLOWS.md §5.12): integer gridline ticks over `0..max`, unit-tested on
 * its own rather than only indirectly through a component render test.
 */

/**
 * Picks 2–3 integer tick values from `0` up to (at least) `maxValue`,
 * evenly spaced, always including `0` and always reaching a value `>=
 * maxValue` so the tallest bar never overflows the axis. `maxValue <= 0`
 * (no data) yields a single `[0]` tick.
 */
export function niceYAxisTicks(maxValue: number, tickCount = 3): number[] {
  const safeMax = Math.max(0, Math.ceil(maxValue));
  if (safeMax === 0) return [0];

  const count = Math.max(2, tickCount) - 1;
  const step = Math.max(1, Math.ceil(safeMax / count));
  const ticks: number[] = [];
  for (let value = 0; value <= step * count; value += step) {
    ticks.push(value);
  }
  return ticks;
}

/** Maps a data value to a `0..1` fraction of the chart's height, given the axis max (the last tick). */
export function barHeightFraction(value: number, axisMax: number): number {
  if (axisMax <= 0) return 0;
  return Math.min(1, Math.max(0, value) / axisMax);
}

/**
 * Fixed `0..100` y-axis ticks for `WeeklyUnmetChart`'s unmet-rate bars (a percentage axis, unlike
 * `niceYAxisTicks`' data-driven one). Five evenly spaced ticks read comfortably when there are
 * enough bars to fill the width; `narrow` (few bars — a compact chart, not the viewport) drops the
 * 25/75 labels to 0/50/100 so they don't crowd a handful of bars.
 */
export function percentTicks(narrow: boolean): number[] {
  return narrow ? [0, 50, 100] : [0, 25, 50, 75, 100];
}
