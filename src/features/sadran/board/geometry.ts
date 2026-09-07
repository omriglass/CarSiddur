// src/features/sadran/board/geometry.ts
//
// Board geometry: ISO timestamp <-> 15-minute slot conversion, and
// client-side conflict detection (overlap / turnaround buffer / car
// location) reused directly from the pure solver (`CarTimeline`,
// `buildTimelines` — docs/SOLVER.md §3.2) rather than reimplemented, per the
// stage 2b brief ("reuse solver helpers"). No React, no Supabase here.

import { formatInTimeZone } from "date-fns-tz";
import { TZ } from "@/lib/time";
import { buildTimelines } from "@/solver";

import type { Car as SolverCar, DayBounds, Window } from "@/solver";

export const SLOT_MINUTES = 15;
const SLOT_MS = SLOT_MINUTES * 60 * 1000;

/** ISO timestamp -> 15-minute slot index since `weekStartMs` (may be negative/out of range; callers clamp for display). */
export function isoToSlot(iso: string, weekStartMs: number): number {
  return Math.round((Date.parse(iso) - weekStartMs) / SLOT_MS);
}

/** Slot index -> ISO timestamp, the inverse of `isoToSlot`. */
export function slotToIso(slot: number, weekStartMs: number): string {
  return new Date(weekStartMs + slot * SLOT_MS).toISOString();
}

/** Minutes since Asia/Jerusalem local midnight of the ride's own day, for `WeekGrid`'s per-day layout. */
export function isoToMinutesSinceMidnight(iso: string, dayStartIso: string): number {
  return Math.round((Date.parse(iso) - Date.parse(dayStartIso)) / 60_000);
}

export function snapMinutesTo15(minutes: number): number {
  return Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES;
}

/** `true` iff a `shiftMinutes` move (signed; negative = earlier) is within the member's declared flexibility. */
export function withinFlex(
  shiftMinutes: number,
  earlier: number | "day",
  later: number | "day",
): boolean {
  if (shiftMinutes === 0) return true;
  if (shiftMinutes < 0) return earlier === "day" || Math.abs(shiftMinutes) <= earlier;
  return later === "day" || shiftMinutes <= later;
}

export interface BoardRideForConflict {
  id: string;
  carId: string;
  startsAt: string;
  endsAt: string;
  originId: string;
  destinationId: string;
  overnightAck: boolean;
}

export interface ConflictScanResult {
  /** Ride ids that overlap another ride on the same car (within the buffer) or start where the car isn't. */
  conflictRideIds: Set<string>;
  /** Per car, windows where the car is away from home (for the board's location badge). */
  awayByCarId: Map<string, { locationId: string; window: Window }[]>;
  /** Per car, day-end violations (away at day end, not acknowledged) — the board's overnight warning. */
  dayEndViolationsByCarId: Map<string, { window: Window; causeRideId?: string }[]>;
}

/**
 * Scans every ride of the board (one department/week, all days at once so
 * overnight relay chains are seen whole) for conflicts, reusing the solver's
 * own `CarTimeline` (buffer + location rules, SOLVER.md §1.3.1/§1.3.8) rather
 * than re-implementing that arithmetic. `isFree` is checked before each ride
 * is added (in start-time order) so an out-of-order/overlapping edit is
 * flagged without throwing; `forceAdd` then keeps the timeline consistent
 * for the rest of the scan regardless of the outcome.
 */
export function scanBoardConflicts(params: {
  rides: readonly BoardRideForConflict[];
  carIds: readonly string[];
  weekStartMs: number;
  bufferMinutes: number;
  homeLocationId: string;
  days: readonly DayBounds[];
}): ConflictScanResult {
  const bufferSlots = Math.round(params.bufferMinutes / SLOT_MINUTES);
  const days = [...params.days];
  const weekSlots = days.reduce((max, d) => Math.max(max, d.endSlot), 0);
  const stubCars: SolverCar[] = params.carIds.map((id) => ({
    id,
    name: id,
    type: "shared",
    seatConfigs: [],
    features: [],
    luggageCapacity: 0,
    maintenance: [],
  }));
  const timelines = buildTimelines(stubCars, bufferSlots, weekSlots, params.homeLocationId);

  const conflictRideIds = new Set<string>();
  const sorted = [...params.rides].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const ride of sorted) {
    const tl = timelines.get(ride.carId);
    if (!tl) continue;
    const window: Window = {
      start: isoToSlot(ride.startsAt, params.weekStartMs),
      end: isoToSlot(ride.endsAt, params.weekStartMs),
    };
    const free = tl.isFree(window, ride.originId);
    if (!free) conflictRideIds.add(ride.id);
    try {
      // `forceAdd` skips the location check (already covered by `isFree`
      // above) but still throws on a genuine time overlap — expected here
      // for a ride we just flagged as conflicting. Swallow it: the block
      // simply isn't added to the timeline, so a *third* ride overlapping
      // only this one (not the first) could be missed — an accepted
      // limitation of a client-side scan (a real conflict always involves
      // at least one flagged pair either way).
      tl.forceAdd({
        rideId: ride.id,
        window,
        startLocationId: ride.originId,
        endLocationId: ride.destinationId,
        overnightAck: ride.overnightAck,
      });
    } catch {
      // already recorded in conflictRideIds above.
    }
  }

  const awayByCarId = new Map<string, { locationId: string; window: Window }[]>();
  const dayEndViolationsByCarId = new Map<string, { window: Window; causeRideId?: string }[]>();
  for (const carId of params.carIds) {
    const tl = timelines.get(carId);
    if (!tl) continue;
    awayByCarId.set(carId, [...tl.awayWindows()]);
    dayEndViolationsByCarId.set(carId, [...tl.dayEndViolations(days)]);
  }

  return { conflictRideIds, awayByCarId, dayEndViolationsByCarId };
}

/**
 * Quick single-car check for an in-progress drag/resize preview (before the
 * candidate window is committed via `edit_ride`): does it overlap any of the
 * car's *other* rides within the turnaround buffer? A lighter-weight sibling
 * of `scanBoardConflicts` for the 60fps drag path, expressed with the same
 * buffer semantics as `CarTimeline`'s `tooClose` (SOLVER.md §3.2).
 */
export function wouldOverlap(
  candidate: { startsAt: string; endsAt: string },
  otherRidesOnCar: readonly { startsAt: string; endsAt: string }[],
  bufferMinutes: number,
): boolean {
  const bufferMs = bufferMinutes * 60_000;
  const start = Date.parse(candidate.startsAt);
  const end = Date.parse(candidate.endsAt);
  return otherRidesOnCar.some((r) => {
    const rs = Date.parse(r.startsAt);
    const re = Date.parse(r.endsAt);
    return start < re + bufferMs && rs < end + bufferMs;
  });
}

/** Detect legacy wrong-day placements without changing their data. Return legs
 * are anchored to requested arrival; outbound/both legs to requested departure.
 * Reads the board view's JSON served links and plain request rows only.
 */
export function requestDayMismatchRideIds(
  rides: readonly { id: string | null; starts_at: string | null; served: unknown }[],
  requests: readonly { id: string; trip_shape: string; depart_at: string | null; return_at: string | null }[],
): Set<string> {
  const byId = new Map(requests.map((request) => [request.id, request]));
  const invalid = new Set<string>();
  for (const ride of rides) {
    if (!ride.id || !ride.starts_at || !Array.isArray(ride.served)) continue;
    const day = formatInTimeZone(ride.starts_at, TZ, "yyyy-MM-dd");
    for (const entry of ride.served) {
      if (!entry || typeof entry !== "object" || typeof entry.request_id !== "string") continue;
      const request = byId.get(entry.request_id);
      if (!request) continue;
      const anchor = entry.leg === "return" || request.trip_shape === "one_way_from" ? request.return_at : request.depart_at;
      if (anchor && formatInTimeZone(anchor, TZ, "yyyy-MM-dd") !== day) invalid.add(ride.id);
    }
  }
  return invalid;
}
