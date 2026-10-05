// REQ §13.101 (j, QF5): "fewer days for a multi-day request". Pure helpers: pick a consecutive
// sub-span of the series' legs and build the shift prefill the board's proposal flow takes.
import type { SeriesLeg } from "../api";

export interface SeriesSpan {
  depart_at: string;
  return_at: string;
}

/** The legs a sub-span may start/end on: the live ones, in day order. */
export function activeSeriesLegs(legs: readonly SeriesLeg[]): SeriesLeg[] {
  return legs.filter((leg) => leg.status !== "withdrawn" && leg.status !== "cancelled")
    .sort((a, b) => Date.parse(a.departAt) - Date.parse(b.departAt) || a.id.localeCompare(b.id));
}

/** The series head: the first leg (lowest `series_index`, else the earliest day). */
export function seriesHead(legs: readonly SeriesLeg[]): SeriesLeg | null {
  return [...legs].sort((a, b) => a.seriesIndex - b.seriesIndex || Date.parse(a.departAt) - Date.parse(b.departAt))[0] ?? null;
}

/**
 * The span from leg `from` to leg `to` (indices into `legs`, inclusive); `null` when it is not a
 * consecutive, non-empty, strictly shorter sub-span.
 */
export function buildSeriesSpan(legs: readonly SeriesLeg[], from: number, to: number): SeriesSpan | null {
  const first = legs[from];
  const last = legs[to];
  if (!first || !last || from > to || to - from + 1 >= legs.length) return null;
  return { depart_at: first.departAt, return_at: last.returnAt };
}

/** The proposal prefill (`type: 'shift'`) carrying `car_id` and `series_span` (no single-day times). */
export function seriesSpanPrefill(headRequestId: string, carId: string, span: SeriesSpan) {
  return { requestId: headRequestId, rideId: null, type: "shift" as const, payload: { car_id: carId, series_span: span } };
}
