// src/solver/slots.ts
//
// 15-minute grid normalization (docs/SOLVER.md §3.1). The caller supplies
// epoch timestamps and per-day DayBounds; this module never does wall-clock
// or timezone arithmetic — only integer slot math relative to
// `week.startMs` and the supplied day boundaries.

import type {
  Car,
  DayBounds,
  LegCarMode,
  LegSide,
  Passengers,
  Request,
  SolverInput,
  TripType,
  Window,
} from './types';
import { fits } from './seatFit';
import { reason } from './reasons';
import { effectiveTripType, legRouteSlots, originIdOf, resolveStopMinutes, travelBetween } from './travel';

export const SLOT_MS = 15 * 60 * 1000;

export function toSlotFloor(ms: number, weekStartMs: number): number {
  return Math.floor((ms - weekStartMs) / SLOT_MS);
}

export function toSlotCeil(ms: number, weekStartMs: number): number {
  return Math.ceil((ms - weekStartMs) / SLOT_MS);
}

export function isAligned(ms: number, weekStartMs: number): boolean {
  return (ms - weekStartMs) % SLOT_MS === 0;
}

/** minutes represented by a signed slot delta */
export function slotsToMinutes(slots: number): number {
  return slots * 15;
}

export function minutesToSlots(minutes: number): number {
  return Math.round(minutes / 15);
}

/** Finds the DayBounds containing `slot`; falls back to the last day if out of range. */
export function dayBoundsForSlot(days: DayBounds[], slot: number): DayBounds {
  for (const d of days) {
    if (slot >= d.startSlot && slot < d.endSlot) return d;
  }
  return days[days.length - 1] ?? { dayIndex: 0, startSlot: 0, endSlot: 96, dayEndSlot: 95 };
}

/** Pure arithmetic HH:MM formatting of a slot's time-of-day (no Date/timezone APIs). */
export function formatSlotTime(slot: number, day: DayBounds): string {
  const minutesFromDayStart = (slot - day.startSlot) * 15;
  const hh = Math.floor(minutesFromDayStart / 60) % 24;
  const mm = ((minutesFromDayStart % 60) + 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function resolveFlexBound(base: number, flex: number | 'day', direction: 'earlier' | 'later', day: DayBounds): number {
  if (flex === 'day') return direction === 'earlier' ? day.startSlot : day.endSlot;
  const delta = minutesToSlots(flex);
  return direction === 'earlier' ? base - delta : base + delta;
}

export interface NormalizedLeg {
  side: LegSide;
  preferredMode: LegCarMode;
  originId: string;
  destinationId: string;
  window: Window;
}

export interface NormalizedRequest {
  id: string;
  request: Request;
  /** legs the solver may place directly on a car; empty/unused for passenger-only requests */
  legs: NormalizedLeg[];
  window: Window;
  minDurationSlots: number;
  flexDep: [number, number];
  flexRet: [number, number];
  durationFixed: boolean;
  travelSlots: number;
  passengers: Passengers;
  luggage: boolean;
  destinationId: string;
  dayIndex: number;
  /** Hard scheduling bounds, independent of declared or suggested flexibility. */
  dayWindow: Window;
  /** one-way passenger mode: the solver never places this itself; it is served only via merge/chauffeur suggestions */
  isPassengerOnly: boolean;
  /** `request.originId`, or the department home when unset (REQUIREMENTS §13.93). Equals `legs[*].originId`/`destinationId` as appropriate. */
  originId: string;
  /** derived via `effectiveTripType()` (REQUIREMENTS §13.93) */
  tripType: TripType;
}

function requestDayWindow(request: Request, day: DayBounds, weekStartMs: number): Window {
  // 23:59 is conservatively represented by the next boundary slot internally.
  // Persistence restores its exact minute; other rides end on a quarter hour.
  const exactEndOfDay = request.returnMs === weekStartMs + day.endSlot * SLOT_MS - 60_000;
  return { start: day.startSlot, end: day.endSlot - (exactEndOfDay ? 0 : 1) };
}

export function withinRequestDay(nr: NormalizedRequest, window: Window): boolean {
  return window.start >= nr.dayWindow.start && window.end <= nr.dayWindow.end && window.end > window.start;
}

function boundedFlex(bounds: [number, number], window: Window): [number, number] {
  return [Math.max(bounds[0], window.start), Math.min(bounds[1], window.end)];
}

export interface Warning {
  code: string;
  message: string;
  requestId?: string;
}

/**
 * Travel time (in 15-min slots) of a leg between `originId` and
 * `destinationId` (REQUIREMENTS §13.93, ORIGINS_PLAN §4): replaces the old
 * direct `destinations[id].travelMinutes` lookup (which implicitly assumed
 * every leg started at home) with `travelBetween()`, origin-aware.
 */
export function travelSlotsFor(input: SolverInput, originId: string, destinationId: string): number {
  const { minutes } = travelBetween(input, originId, destinationId);
  return Math.max(1, Math.ceil(minutes / 15));
}

/** Builds the fallback/only 'both' (keep) leg of a round trip (and, generalized, a
 * `drop_off` round trip): the car block starts and ends at `origin`; the requester's
 * travel to the destination is recorded on the AssignmentLeg, not on the car block itself. */
function buildKeepLeg(origin: string, D: number, R: number): NormalizedLeg {
  return { side: 'both', preferredMode: 'keep', originId: origin, destinationId: origin, window: { start: D, end: R } };
}

/**
 * Whether this request has an eligible driver on board (REQUIREMENTS §13.88,
 * rule made precise 2026-09-16): the requester themself when they can drive,
 * or a named companion who can drive when the requester cannot. This is a
 * per-request fact, independent of whether the leg ends up paired.
 */
export function hasEligibleDriver(request: Request): boolean {
  return request.canDrive !== false || (request.drivingCompanionIds?.length ?? 0) > 0;
}

/**
 * The member who would actually drive, if this request supplies a leg's
 * driver: the requester when they can drive, else the lexicographically-first
 * driving companion (deterministic, REQUIREMENTS §13.88 owner 2026-09-16 —
 * "a driving companion becomes the driver automatically"). `undefined` when
 * `hasEligibleDriver(request)` is false.
 */
export function eligibleDriverMemberId(request: Request): string | undefined {
  if (request.canDrive !== false) return request.memberId;
  const companions = request.drivingCompanionIds;
  if (!companions || companions.length === 0) return undefined;
  return [...companions].sort()[0];
}

/**
 * A one-way leg's *candidate* mode (REQUIREMENTS §13.88, rule made precise
 * 2026-09-16): the member never chooses this on the form, and the stored
 * `oneWayCarMode` is now ignored entirely — pairing decides the mode, not the
 * member. A leg with an eligible driver on board (see `hasEligibleDriver`) is
 * a **relay candidate**: `relay.ts`'s pairing either confirms it as a real
 * `relay` leg (a matching leg at the same destination) or it is placed as a
 * standalone `chauffeur` ride when no match exists (§3.6.1a) — never left
 * waiting at the destination. A leg with no eligible driver on board is
 * `passenger` unconditionally (a seat in someone else's ride, falling back to
 * `chauffeur`, §3.11 item 5, when no host exists).
 */
export function resolveOneWayMode(request: Request): 'relay' | 'passenger' {
  return hasEligibleDriver(request) ? 'relay' : 'passenger';
}

/** The independent out-leg of a round trip (used by relay pairing / splitLegs when needsCarAtDestination = false).
 *  `home` is accepted for backward compatibility but ignored — the leg always uses the request's own origin
 *  (`nr.originId`, REQUIREMENTS §13.93), which equals `home` for every legacy (home-origin) request. */
export function roundTripOutLeg(nr: NormalizedRequest, home?: string): NormalizedLeg {
  void home;
  const D = nr.window.start;
  return {
    side: 'out',
    preferredMode: resolveOneWayMode(nr.request),
    originId: nr.originId,
    destinationId: nr.destinationId,
    window: { start: D, end: D + nr.travelSlots },
  };
}

/** The independent return-leg of a round trip. See `roundTripOutLeg` re: `home`. */
export function roundTripReturnLeg(nr: NormalizedRequest, home?: string): NormalizedLeg {
  void home;
  const R = nr.window.end;
  return {
    side: 'return',
    preferredMode: resolveOneWayMode(nr.request),
    originId: nr.destinationId,
    destinationId: nr.originId,
    window: { start: R - nr.travelSlots, end: R },
  };
}

/**
 * One in-week leg of a multi-day series request (docs/SOLVER.md §3.x). The
 * DB stores one request row per calendar day sharing `seriesId`; the solver
 * only ever sees the legs that fall inside the week being solved.
 * `originId`/`destinationId` are the *car's* location at the start/end of
 * this leg — home only at the true start/end of the whole series (global
 * `seriesIndex === 1` / `=== seriesCount`), the series' own destination in
 * between (the car is parked there overnight). `flexDep`/`flexRet` are only
 * ever non-degenerate on the leg that is also the true global first/last
 * leg — every other leg's day-boundary timestamp (00:00 / 23:59) is fixed.
 */
export interface SeriesLeg {
  requestId: string;
  request: Request;
  seriesIndex: number;
  window: Window;
  originId: string;
  destinationId: string;
  passengers: Passengers;
  luggage: boolean;
  dayIndex: number;
  flexDep: [number, number];
  flexRet: [number, number];
}

export interface SeriesUnit {
  seriesId: string;
  seriesCount: number;
  destinationId: string;
  /** sorted by seriesIndex ascending; only the legs present in this week's input */
  legs: SeriesLeg[];
  /** built from the first in-week leg's own request row via the ordinary round-trip
   *  normalization, so the policy engine can score it exactly like any other request
   *  (SOLVER §3.x: "the series unit is ranked by the first leg's score") */
  scoreProxy: NormalizedRequest;
}

export interface NormalizeResult {
  normalized: NormalizedRequest[];
  servedByFixed: Set<string>;
  warnings: Warning[];
  seriesUnits: SeriesUnit[];
  /** requests with `originIsFreeText = true` (REQUIREMENTS §13.93 item 5): never normalized, never placed. */
  freeTextOriginIds: Set<string>;
}

/** Builds the same NormalizedRequest shape the main loop's round_trip branch produces — factored out
 *  so a multi-day series' first in-week leg can be scored by the ordinary policy engine (SOLVER §3.x). */
function buildRoundTripNormalized(
  request: Request,
  input: SolverInput,
  origin: string,
  D: number,
  R: number,
  travelSlots: number,
): NormalizedRequest {
  const day = dayBoundsForSlot(input.week.days, D);
  const dayWindow = requestDayWindow(request, day, input.week.startMs);
  const flexDep: [number, number] = [
    resolveFlexBound(D, request.flexDeparture.earlierMin, 'earlier', day),
    resolveFlexBound(D, request.flexDeparture.laterMin, 'later', day),
  ];
  const flexRet: [number, number] = [
    resolveFlexBound(R, request.flexReturn.earlierMin, 'earlier', day),
    resolveFlexBound(R, request.flexReturn.laterMin, 'later', day),
  ];
  return {
    id: request.id,
    request,
    legs: [buildKeepLeg(origin, D, R)],
    window: { start: D, end: R },
    minDurationSlots: Math.max(1, R - D),
    flexDep: boundedFlex(flexDep, { ...dayWindow, end: day.endSlot - 1 }),
    flexRet: boundedFlex(flexRet, dayWindow),
    durationFixed: false,
    travelSlots,
    passengers: request.passengers,
    luggage: request.luggage,
    destinationId: request.destinationId,
    dayIndex: day.dayIndex,
    dayWindow,
    isPassengerOnly: false,
    originId: origin,
    tripType: effectiveTripType(request),
  };
}

/** Groups the week's in-week legs of every multi-day series request and builds their SeriesUnit
 *  (docs/SOLVER.md §3.x). Never throws: a leg with unusable timestamps degenerates to a zero-length
 *  window, which simply never fits any car and surfaces as UNMET_SERIES_NO_CAR. */
function buildSeriesUnits(
  seriesRequests: Request[],
  input: SolverInput,
  warnings: Warning[],
): SeriesUnit[] {
  const home = input.homeLocationId;
  const groups = new Map<string, Request[]>();
  for (const request of seriesRequests) {
    const list = groups.get(request.seriesId as string) ?? [];
    list.push(request);
    groups.set(request.seriesId as string, list);
  }

  const seriesUnits: SeriesUnit[] = [];
  for (const seriesId of [...groups.keys()].sort()) {
    const group = [...(groups.get(seriesId) ?? [])].sort(
      (a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0) || byId(a, b),
    );
    const seriesCount = group[0]?.seriesCount ?? group.length;
    const legs: SeriesLeg[] = [];

    for (const request of group) {
      if (input.cars.length > 0 && !input.cars.some((c) => fits(c, request.passengers))) {
        warnings.push({ code: 'NO_CAR_FITS_SEATS', message: 'WARN_NO_CAR_FITS_SEATS', requestId: request.id });
      }
      const seriesIndex = request.seriesIndex ?? 0;
      const isGlobalFirst = seriesIndex === 1;
      const isGlobalLast = seriesIndex === seriesCount;

      if (request.departureMs === undefined || request.returnMs === undefined) {
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: reason('WARN_TIME_NOT_ALIGNED'), requestId: request.id });
        legs.push({
          requestId: request.id,
          request,
          seriesIndex,
          window: { start: 0, end: 0 },
          originId: isGlobalFirst ? originIdOf(request, home) : request.destinationId,
          destinationId: isGlobalLast ? originIdOf(request, home) : request.destinationId,
          passengers: request.passengers,
          luggage: request.luggage,
          dayIndex: 0,
          flexDep: [0, 0],
          flexRet: [0, 0],
        });
        continue;
      }
      if (!isAligned(request.departureMs, input.week.startMs) || !isAligned(request.returnMs, input.week.startMs)) {
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: reason('WARN_TIME_NOT_ALIGNED'), requestId: request.id });
      }
      const D = toSlotFloor(request.departureMs, input.week.startMs);
      const R = toSlotCeil(request.returnMs, input.week.startMs);
      const day = dayBoundsForSlot(input.week.days, D);
      const dayWindow = requestDayWindow(request, day, input.week.startMs);

      // Flexibility only ever applies to the leg that is also the true global
      // first/last leg of the whole series (SOLVER §3.x); every other leg's
      // day-boundary timestamp (00:00 / 23:59) is fixed.
      const flexDep: [number, number] = isGlobalFirst
        ? boundedFlex(
            [
              resolveFlexBound(D, request.flexDeparture.earlierMin, 'earlier', day),
              resolveFlexBound(D, request.flexDeparture.laterMin, 'later', day),
            ],
            { ...dayWindow, end: day.endSlot - 1 },
          )
        : [D, D];
      const flexRet: [number, number] = isGlobalLast
        ? boundedFlex(
            [
              resolveFlexBound(R, request.flexReturn.earlierMin, 'earlier', day),
              resolveFlexBound(R, request.flexReturn.laterMin, 'later', day),
            ],
            dayWindow,
          )
        : [R, R];

      legs.push({
        requestId: request.id,
        request,
        seriesIndex,
        window: { start: D, end: R },
        originId: isGlobalFirst ? originIdOf(request, home) : request.destinationId,
        destinationId: isGlobalLast ? originIdOf(request, home) : request.destinationId,
        passengers: request.passengers,
        luggage: request.luggage,
        dayIndex: day.dayIndex,
        flexDep,
        flexRet,
      });
    }

    legs.sort((a, b) => a.seriesIndex - b.seriesIndex);
    const first = legs[0];
    if (!first) continue;
    const firstOrigin = originIdOf(first.request, home);
    const travelSlots = travelSlotsFor(input, firstOrigin, first.request.destinationId);
    seriesUnits.push({
      seriesId,
      seriesCount,
      destinationId: first.request.destinationId,
      legs,
      scoreProxy: buildRoundTripNormalized(first.request, input, firstOrigin, first.window.start, first.window.end, travelSlots),
    });
  }
  return seriesUnits;
}

export function normalize(input: SolverInput): NormalizeResult {
  const warnings: Warning[] = [];
  const servedByFixed = new Set<string>();
  for (const fr of input.fixedRides) {
    for (const rid of fr.servedRequestIds) servedByFixed.add(rid);
  }

  const home = input.homeLocationId;
  const stopMinutes = resolveStopMinutes(input.config);
  const sortedRequests = [...input.requests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const normalized: NormalizedRequest[] = [];
  const seriesRequests: Request[] = [];
  const freeTextOriginIds = new Set<string>();

  for (const request of sortedRequests) {
    if (servedByFixed.has(request.id)) continue;
    if (request.seriesId !== undefined) {
      seriesRequests.push(request);
      continue;
    }
    // REQUIREMENTS §13.93 / ORIGINS_PLAN §4 item 5: a free-text origin is never
    // placed — it is never even given a leg; it surfaces as its own unmet
    // reason (UNMET_FREE_TEXT_ORIGIN) in index.ts.
    if (request.originIsFreeText) {
      freeTextOriginIds.add(request.id);
      continue;
    }
    const origin = originIdOf(request, home);
    const tripType = effectiveTripType(request);
    const travelSlots = travelSlotsFor(input, origin, request.destinationId);

    if (input.cars.length > 0 && !input.cars.some((c) => fits(c, request.passengers))) {
      warnings.push({ code: 'NO_CAR_FITS_SEATS', message: 'WARN_NO_CAR_FITS_SEATS', requestId: request.id });
    }

    // New explicit `one_way` trip type (REQUIREMENTS §13.93): a single relay
    // leg origin -> destination, unconditionally (no passenger fallback — the
    // SQL side refuses this trip type to a non-driver with no driving
    // companion), no pairing obligation and no chauffeur conversion (§4 item
    // 4). Placement is governed only by `CarTimeline.isFree`'s end-check
    // (the car's next block, if any, must start at the destination).
    if (request.tripShape === 'one_way_to' && tripType === 'one_way') {
      if (request.departureMs === undefined) continue;
      if (!isAligned(request.departureMs, input.week.startMs)) {
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: reason('WARN_TIME_NOT_ALIGNED'), requestId: request.id });
      }
      // Multi-stop rides (REQUIREMENTS §13.93): the leg's own route duration,
      // not the plain origin<->destination lookup — equal to it when there
      // are no out-stops.
      const travelSlots = legRouteSlots(input, request, 'out', stopMinutes);
      const D = toSlotFloor(request.departureMs, input.week.startMs);
      const day = dayBoundsForSlot(input.week.days, D);
      const dayWindow = requestDayWindow(request, day, input.week.startMs);
      const flexDep: [number, number] = [
        resolveFlexBound(D, request.flexDeparture.earlierMin, 'earlier', day),
        resolveFlexBound(D, request.flexDeparture.laterMin, 'later', day),
      ];
      const window = { start: D, end: D + travelSlots };
      normalized.push({
        id: request.id,
        request,
        legs: [{ side: 'out', preferredMode: 'relay', originId: origin, destinationId: request.destinationId, window }],
        window,
        minDurationSlots: Math.max(1, travelSlots),
        flexDep: boundedFlex(flexDep, dayWindow),
        flexRet: [D, D],
        durationFixed: true,
        travelSlots,
        passengers: request.passengers,
        luggage: request.luggage,
        destinationId: request.destinationId,
        dayIndex: day.dayIndex,
        dayWindow,
        isPassengerOnly: false,
        originId: origin,
        tripType,
      });
      continue;
    }

    if (request.tripShape === 'round_trip') {
      if (request.departureMs === undefined || request.returnMs === undefined) {
        // malformed input; skip rather than throw (normalization never throws)
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: reason('WARN_TIME_NOT_ALIGNED'), requestId: request.id });
        continue;
      }
      if (!isAligned(request.departureMs, input.week.startMs) || !isAligned(request.returnMs, input.week.startMs)) {
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: reason('WARN_TIME_NOT_ALIGNED'), requestId: request.id });
      }
      const D = toSlotFloor(request.departureMs, input.week.startMs);
      const R = toSlotCeil(request.returnMs, input.week.startMs);
      const day = dayBoundsForSlot(input.week.days, D);
      const dayWindow = requestDayWindow(request, day, input.week.startMs);
      const flexDep: [number, number] = [
        resolveFlexBound(D, request.flexDeparture.earlierMin, 'earlier', day),
        resolveFlexBound(D, request.flexDeparture.laterMin, 'later', day),
      ];
      const flexRet: [number, number] = [
        resolveFlexBound(R, request.flexReturn.earlierMin, 'earlier', day),
        resolveFlexBound(R, request.flexReturn.laterMin, 'later', day),
      ];
      normalized.push({
        id: request.id,
        request,
        legs: [buildKeepLeg(origin, D, R)],
        window: { start: D, end: R },
        minDurationSlots: Math.max(1, R - D),
        flexDep: boundedFlex(flexDep, { ...dayWindow, end: day.endSlot - 1 }),
        flexRet: boundedFlex(flexRet, dayWindow),
        durationFixed: false,
        travelSlots,
        passengers: request.passengers,
        luggage: request.luggage,
        destinationId: request.destinationId,
        dayIndex: day.dayIndex,
        dayWindow,
        isPassengerOnly: false,
        originId: origin,
        tripType,
      });
      continue;
    }

    // One-way shapes (legacy `one_way_to`/`one_way_from`, or an explicit
    // `drop_off` with no pickup leg — REQUIREMENTS §13.93 derives both to
    // `drop_off`): durationFixed = true (single shift dimension). The member
    // never states a mode on the form (REQUIREMENTS §13.88) and any stored
    // `oneWayCarMode` is ignored — `resolveOneWayMode` returns the *candidate*
    // mode (relay-eligible vs. definite passenger); pairing (`relay.ts`) decides
    // whether a relay candidate ends up a real relay leg or a chauffeur ride.
    const mode = resolveOneWayMode(request);

    if (request.tripShape === 'one_way_to') {
      if (request.departureMs === undefined) continue;
      if (!isAligned(request.departureMs, input.week.startMs)) {
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: reason('WARN_TIME_NOT_ALIGNED'), requestId: request.id });
      }
      // Multi-stop rides (REQUIREMENTS §13.93): route-aware, equal to the
      // plain lookup when there are no out-stops.
      const travelSlots = legRouteSlots(input, request, 'out', stopMinutes);
      const D = toSlotFloor(request.departureMs, input.week.startMs);
      const day = dayBoundsForSlot(input.week.days, D);
      const dayWindow = requestDayWindow(request, day, input.week.startMs);
      const flexDep: [number, number] = [
        resolveFlexBound(D, request.flexDeparture.earlierMin, 'earlier', day),
        resolveFlexBound(D, request.flexDeparture.laterMin, 'later', day),
      ];
      const window = mode === 'relay' ? { start: D, end: D + travelSlots } : { start: D, end: D };
      normalized.push({
        id: request.id,
        request,
        legs: [{ side: 'out', preferredMode: mode, originId: origin, destinationId: request.destinationId, window }],
        window,
        minDurationSlots: mode === 'relay' ? Math.max(1, travelSlots) : 0,
        flexDep: boundedFlex(flexDep, dayWindow),
        flexRet: [D, D],
        durationFixed: true,
        travelSlots,
        passengers: request.passengers,
        luggage: request.luggage,
        destinationId: request.destinationId,
        dayIndex: day.dayIndex,
        dayWindow,
        isPassengerOnly: mode === 'passenger',
        originId: origin,
        tripType,
      });
      continue;
    }

    // one_way_from (always `drop_off`: see effectiveTripType — there is no
    // "return-only" new trip type, §1 of ORIGINS_PLAN)
    if (request.returnMs === undefined) continue;
    if (!isAligned(request.returnMs, input.week.startMs)) {
      warnings.push({ code: 'TIME_NOT_ALIGNED', message: reason('WARN_TIME_NOT_ALIGNED'), requestId: request.id });
    }
    // Multi-stop rides (REQUIREMENTS §13.93): route-aware, equal to the plain
    // lookup when there are no return-stops. (Named distinctly from the outer
    // origin<->destination `travelSlots` above, still in scope here.)
    const returnTravelSlots = legRouteSlots(input, request, 'return', stopMinutes);
    const R = toSlotCeil(request.returnMs, input.week.startMs);
    const day = dayBoundsForSlot(input.week.days, toSlotFloor(request.returnMs, input.week.startMs));
    const dayWindow = requestDayWindow(request, day, input.week.startMs);
    const flexRet: [number, number] = [
      resolveFlexBound(R, request.flexReturn.earlierMin, 'earlier', day),
      resolveFlexBound(R, request.flexReturn.laterMin, 'later', day),
    ];
    const window = mode === 'relay' ? { start: R - returnTravelSlots, end: R } : { start: R, end: R };
    normalized.push({
      id: request.id,
      request,
      legs: [{ side: 'return', preferredMode: mode, originId: request.destinationId, destinationId: origin, window }],
      window,
      minDurationSlots: mode === 'relay' ? Math.max(1, returnTravelSlots) : 0,
      flexDep: [R, R],
      flexRet: boundedFlex(flexRet, dayWindow),
      durationFixed: true,
      travelSlots: returnTravelSlots,
      passengers: request.passengers,
      luggage: request.luggage,
      destinationId: request.destinationId,
      dayIndex: day.dayIndex,
      dayWindow,
      isPassengerOnly: mode === 'passenger',
      originId: origin,
      tripType,
    });
  }

  const seriesUnits = buildSeriesUnits(seriesRequests, input, warnings);

  return { normalized, servedByFixed, warnings, seriesUnits, freeTextOriginIds };
}

/** Total-order request id comparator used everywhere as the final tie-break (determinism). */
export function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function carsById(cars: Car[]): Map<string, Car> {
  return new Map(cars.map((c) => [c.id, c]));
}
