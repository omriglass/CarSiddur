// REQ §13.101 (j, QF5): "fewer days for a multi-day request". Pure helpers: pick a consecutive
// sub-span of the series' legs and build the shift prefill the board's proposal flow takes.
import { dateKey, formatTime, TZ } from "@/lib/time";
import { fromZonedTime } from "date-fns-tz";

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

/** `day`'s calendar date (Jerusalem) at the wall-clock time of `timeOf`. */
function dayAtTimeOf(day: string, timeOf: string): string {
  return fromZonedTime(`${dateKey(day)}T${formatTime(new Date(timeOf))}:00`, TZ).toISOString();
}

/**
 * The span from leg `from` to leg `to` (indices into `legs`, inclusive); `null` when it is not a
 * consecutive, non-empty, strictly shorter sub-span. REQ §13.105 d: a span that does not start on the
 * series' first day (or end on its last) takes the series' real departure (return) time of day instead of
 * the held-all-day 00:00 (23:59) of a middle leg, so the sent text and the placed ride carry real times.
 */
export function buildSeriesSpan(legs: readonly SeriesLeg[], from: number, to: number): SeriesSpan | null {
  const first = legs[from];
  const last = legs[to];
  if (!first || !last || from > to || to - from + 1 >= legs.length) return null;
  const depart = from === 0 ? first.departAt : dayAtTimeOf(first.departAt, legs[0]!.departAt);
  let ret = to === legs.length - 1 ? last.returnAt : dayAtTimeOf(last.returnAt, legs[legs.length - 1]!.returnAt);
  // A real return that is not after the real departure (same day) is held until the end of that day instead.
  if (Date.parse(ret) <= Date.parse(depart)) ret = fromZonedTime(`${dateKey(last.returnAt)}T23:59:00`, TZ).toISOString();
  return { depart_at: depart, return_at: ret };
}

/** The proposal prefill (`type: 'shift'`) carrying `car_id` and `series_span` (no single-day times). */
export function seriesSpanPrefill(headRequestId: string, carId: string, span: SeriesSpan) {
  return { requestId: headRequestId, rideId: null, type: "shift" as const, payload: { car_id: carId, series_span: span } };
}
