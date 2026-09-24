import { formatDayDate } from "@/lib/dayLabels";

import type { CarSwapPreview, CarSwapRide, CarSwapSeries } from "./schema";

/** One side of `CarSwapDialog`'s "יועברו N נסיעות" list — the rides currently on `carId`, about to move to the other car. */
export interface CarSwapCarGroup {
  carId: string;
  carName: string;
  rides: readonly CarSwapRide[];
}

/**
 * Splits a preview's flat `rides` array into the two per-car groups the
 * dialog renders (REQ §13.92). Pure — no query/mutation state — so the
 * dialog's own layout logic is unit-testable without mounting anything.
 */
export function groupCarSwapRidesByCar(
  rides: readonly CarSwapRide[],
  carA: { id: string; name: string },
  carB: { id: string; name: string },
): readonly CarSwapCarGroup[] {
  return [carA, carB].map((car) => ({
    carId: car.id,
    carName: car.name,
    rides: rides.filter((r) => r.car_id === car.id),
  }));
}

/**
 * "א׳ 14.9 – ד׳ 17.9" for one series' span (A1's radio label); several
 * series among the moved rides join with "; ". Dates come in as plain
 * `yyyy-MM-dd` strings from the RPC — `formatDayDate` renders them with
 * their weekday, never a raw date (CLAUDE.md hard rule 6).
 */
export function carSwapSeriesRangeLabel(series: readonly CarSwapSeries[]): string {
  return series.map((s) => `${formatDayDate(s.first_day)} – ${formatDayDate(s.last_day)}`).join("; ");
}

/** The confirm button is disabled whenever there is no preview yet, or the preview itself says the swap can't go through. */
export function carSwapConfirmDisabled(preview: CarSwapPreview | undefined): boolean {
  return !preview || !preview.can_swap;
}
