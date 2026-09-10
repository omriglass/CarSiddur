/**
 * Pure arc math for `RideTypePie`'s inline-SVG donut (UX_FLOWS.md §5.12): no
 * chart library, so the fraction-of-circle math for each `stroke-dasharray`
 * arc is unit-tested on its own here rather than only indirectly through a
 * component render test.
 */
export interface PieSegment {
  /** Fraction of the full circle where this segment starts, `0..1`. */
  start: number;
  /** Fraction of the full circle where this segment ends, `0..1`. */
  end: number;
  /** This segment's share of the total, `0..1` (== `end - start`). */
  fraction: number;
}

/**
 * Turns raw values (e.g. rides per ride type) into consecutive `start`/`end`
 * fractions of a full circle, in input order, summing to `1`. Returns `[]`
 * for an empty input or when every value is `0` (nothing to draw — the
 * caller renders the empty state instead).
 */
export function pieSegments(values: readonly number[]): PieSegment[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return [];

  let cursor = 0;
  return values.map((value) => {
    const fraction = Math.max(0, value) / total;
    const start = cursor;
    const end = cursor + fraction;
    cursor = end;
    return { start, end, fraction };
  });
}
