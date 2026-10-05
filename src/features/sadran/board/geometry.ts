// src/features/sadran/board/geometry.ts
//
// Board geometry: ISO timestamp <-> 15-minute slot conversion, and
// client-side conflict detection (overlap / turnaround buffer / car
// location) reused directly from the pure solver (`CarTimeline`,
// `buildTimelines` — docs/SOLVER.md §3.2) rather than reimplemented, per the
// stage 2b brief ("reuse solver helpers"). No React, no Supabase here.

import { dateKey } from "@/lib/time";
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
  /** Effective approved buffer after this ride; absent uses the department default. */
  turnaroundMinutes?: number;
  /** REQ §13.96: a reservation holds the car for time only - its places never move the car. */
  locationNeutral?: boolean;
}

/** Per car: its base location (REQUIREMENTS §13.93, default home) and its location at the
 *  start of this week (`car_start_locations()`, default its base). */
export interface CarLocationInput {
  baseLocationId?: string;
  startLocationId?: string;
}

export interface ChainBreak {
  rideId: string;
  carLocationId: string;
  rideOriginId: string;
}

export interface ConflictScanResult {
  /** Ride ids that overlap another ride on the same car (within the buffer) or start where the car isn't. */
  conflictRideIds: Set<string>;
  /** Per car, windows where the car is away from its *base* (REQUIREMENTS §13.93) — for the board's away band, continuing across days. */
  awayByCarId: Map<string, { locationId: string; window: Window }[]>;
  /**
   * Per car, fixed rides whose recorded start location does not match where the timeline says
   * the car actually is (REQUIREMENTS §13.93, SOLVER.md §1.3a `CarTimeline.chainBreaks()`) — a
   * warning on the ride itself, never a block.
   */
  chainBreaksByCarId: Map<string, ChainBreak[]>;
  /**
   * Per car, where it ends the week when that differs from its base (SOLVER.md §1.3a
   * `weekEndAway()`) — a warning on the car's column, last day of the week, never a block.
   */
  weekEndAwayByCarId: Map<string, { locationId: string } | null>;
}

interface ConflictBlock {
  window: Window;
  startLocationId: string;
  endLocationId: string;
}

/**
 * Raw (un-trimmed) away gaps for one car, walked from its own week-start location through its
 * committed blocks in time order — the UI-layer equivalent of `CarTimeline`'s private
 * `rawGaps()`/`awayWindows()`, reimplemented here because those compare against the department
 * home for every car alike, while REQUIREMENTS §13.93 wants each car's *own* base. Continues
 * across every day of the week by construction (no day boundary is special-cased).
 */
function awayWindowsFromBase(
  blocks: readonly ConflictBlock[],
  startLocationId: string,
  baseLocationId: string,
  weekSlots: number,
): { locationId: string; window: Window }[] {
  const sorted = [...blocks].sort((a, b) => a.window.start - b.window.start);
  const result: { locationId: string; window: Window }[] = [];
  let cursor = 0;
  let location = startLocationId;
  for (const b of sorted) {
    if (b.window.start > cursor && location !== baseLocationId) {
      result.push({ locationId: location, window: { start: cursor, end: b.window.start } });
    }
    cursor = Math.max(cursor, b.window.end);
    location = b.endLocationId;
  }
  if (weekSlots > cursor && location !== baseLocationId) {
    result.push({ locationId: location, window: { start: cursor, end: weekSlots } });
  }
  return result;
}

/**
 * REQ §13.94 (G7): `next` starts at the place `previous` ended and that place is not the car's
 * base — the Sadran's manual handover (the car hands over at X), which waives the turnaround.
 * At the base the buffer still applies.
 */
export function isHandoverPair(
  previous: { destinationId?: string | null },
  next: { originId?: string | null },
  baseLocationId: string | null | undefined,
): boolean {
  return !!previous.destinationId && previous.destinationId === next.originId && previous.destinationId !== baseLocationId;
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
  /** REQUIREMENTS §13.93: per-car base/start location; a car absent here defaults to home for both. */
  carLocationsById?: ReadonlyMap<string, CarLocationInput>;
}): ConflictScanResult {

  const days = [...params.days];
  const weekSlots = days.reduce((max, d) => Math.max(max, d.endSlot), 0);
  const stubCars: SolverCar[] = params.carIds.map((id) => {
    const loc = params.carLocationsById?.get(id);
    return {
      id,
      name: id,
      type: "shared",
      seatConfigs: [],
      features: [],
      luggageCapacity: 0,
      maintenance: [],
      baseLocationId: loc?.baseLocationId,
      startLocationId: loc?.startLocationId,
    };
  });
  const timelines = buildTimelines(stubCars, 0, weekSlots, params.homeLocationId);

  const conflictRideIds = new Set<string>();
  const sorted = [...params.rides].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const previousByCar = new Map<string, BoardRideForConflict>();
  // Where each car is as the scan walks forward; a location-neutral ride (reservation) is
  // treated as starting and ending right there, so it can never break or move the chain.
  const locationByCar = new Map<string, string>();
  for (const id of params.carIds) {
    const loc = params.carLocationsById?.get(id);
    locationByCar.set(id, loc?.startLocationId ?? loc?.baseLocationId ?? params.homeLocationId);
  }
  // Record both sides, including nested overlaps that the timeline cannot add.
  for (let i = 0; i < sorted.length; i++) {
    const ride = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const other = sorted[j]!;
      if (Date.parse(other.startsAt) >= Date.parse(ride.endsAt)) break;
      if (ride.carId === other.carId) { conflictRideIds.add(ride.id); conflictRideIds.add(other.id); }
    }
  }
  for (const ride of sorted) {
    const tl = timelines.get(ride.carId);
    if (!tl) continue;
    const window: Window = {
      start: isoToSlot(ride.startsAt, params.weekStartMs),
      end: isoToSlot(ride.endsAt, params.weekStartMs),
    };
    const previous = previousByCar.get(ride.carId);
    const neutral = !!ride.locationNeutral;
    const here = locationByCar.get(ride.carId) ?? params.homeLocationId;
    const originId = neutral ? here : ride.originId;
    const destinationId = neutral ? here : ride.destinationId;
    locationByCar.set(ride.carId, destinationId);
    const previousBuffer = previous?.turnaroundMinutes ?? params.bufferMinutes;
    // REQ §13.94 (G7) manual handover: a ride that starts exactly where the car's previous ride
    // ended, away from the car's base, has no turnaround to protect (a real overlap is still
    // flagged by the pairwise pass above).
    const handover = !!previous && !neutral && !previous.locationNeutral && isHandoverPair(previous, ride, params.carLocationsById?.get(ride.carId)?.baseLocationId ?? params.homeLocationId);
    const bufferConflict = !!previous && !handover && Date.parse(ride.startsAt) < Date.parse(previous.endsAt) + previousBuffer * 60_000;
    previousByCar.set(ride.carId, ride);
    const free = (handover || tl.isFree(window, originId)) && !bufferConflict;
    if (!free) conflictRideIds.add(ride.id);
    try {
      // `forceAdd` skips the location check (already covered by `isFree`
      // above) but still throws on a genuine time overlap — expected here
      // for a ride we just flagged as conflicting. Swallow it: the block
      // simply isn't added to the timeline, so a *third* ride overlapping
      // only this one (not the first) could be missed — an accepted
      // limitation of a client-side scan (a real conflict always involves
      // at least one flagged pair either way). `overnightAck` is retired
      // (REQUIREMENTS §13.93) — the `Block` type still requires the field,
      // but nothing reads it any more (the deprecated `dayEndViolations()`
      // is never called below).
      tl.forceAdd({
        rideId: ride.id,
        window,
        startLocationId: originId,
        endLocationId: destinationId,
        overnightAck: true,
      });
    } catch {
      // already recorded in conflictRideIds above.
    }
  }

  const awayByCarId = new Map<string, { locationId: string; window: Window }[]>();
  const chainBreaksByCarId = new Map<string, ChainBreak[]>();
  const weekEndAwayByCarId = new Map<string, { locationId: string } | null>();
  for (const carId of params.carIds) {
    const tl = timelines.get(carId);
    if (!tl) continue;
    const loc = params.carLocationsById?.get(carId);
    const startLocationId = loc?.startLocationId ?? params.homeLocationId;
    const baseLocationId = loc?.baseLocationId ?? params.homeLocationId;
    awayByCarId.set(carId, awayWindowsFromBase(tl.allBlocks(), startLocationId, baseLocationId, weekSlots));
    chainBreaksByCarId.set(carId, [...tl.chainBreaks()]);
    weekEndAwayByCarId.set(carId, tl.weekEndAway());
  }

  return { conflictRideIds, awayByCarId, chainBreaksByCarId, weekEndAwayByCarId };
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
    const day = dateKey(ride.starts_at);
    for (const entry of ride.served) {
      if (!entry || typeof entry !== "object" || typeof entry.request_id !== "string") continue;
      const request = byId.get(entry.request_id);
      if (!request) continue;
      const anchor = entry.leg === "return" || request.trip_shape === "one_way_from" ? request.return_at : request.depart_at;
      if (anchor && dateKey(anchor) !== day) invalid.add(ride.id);
    }
  }
  return invalid;
}

/** Both neighboring rides are tight when their real windows do not overlap but
 * leave less than the usual turnaround. This is informational, not a collision.
 */
export function tightScheduleRideIds(
  rides: readonly { id: string | null; car_id: string | null; starts_at: string | null; ends_at: string | null; series_id?: string | null; origin_id?: string | null; destination_id?: string | null }[],
  bufferMinutes: number,
  /** REQ §13.94 (G7): per car base (default `homeLocationId`) — a handover away from it is never tight. */
  options?: { carBaseLocationId?: ReadonlyMap<string, string | null | undefined>; homeLocationId?: string | null },
): Set<string> {
  const tight = new Set<string>();
  const previousByCar = new Map<string, { id: string; end: number; seriesId: string | null; destinationId: string | null }>();
  const ordered = rides.filter((ride): ride is { id: string; car_id: string; starts_at: string; ends_at: string; series_id?: string | null; origin_id?: string | null; destination_id?: string | null } =>
    !!ride.id && !!ride.car_id && !!ride.starts_at && !!ride.ends_at)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.id.localeCompare(b.id));
  for (const ride of ordered) {
    const previous = previousByCar.get(ride.car_id);
    const seriesId = ride.series_id ?? null;
    // Consecutive legs of one multi-day series meet at midnight by design (REQ §13.77);
    // the car simply stays with the same member, so there is no turnaround to squeeze.
    const sameSeries = !!previous && !!seriesId && previous.seriesId === seriesId;
    const gap = previous ? Date.parse(ride.starts_at) - previous.end : null;
    const handover = !!previous && isHandoverPair(previous, { originId: ride.origin_id },
      options?.carBaseLocationId?.get(ride.car_id) ?? options?.homeLocationId);
    if (previous && !sameSeries && !handover && gap != null && gap >= 0 && gap < bufferMinutes * 60_000) {
      tight.add(previous.id);
      tight.add(ride.id);
    }
    previousByCar.set(ride.car_id, { id: ride.id, end: Date.parse(ride.ends_at), seriesId, destinationId: ride.destination_id ?? null });
  }
  return tight;
}
