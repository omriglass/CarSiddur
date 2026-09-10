// src/solver/slots.ts
//
// 15-minute grid normalization (docs/SOLVER.md §3.1). The caller supplies
// epoch timestamps and per-day DayBounds; this module never does wall-clock
// or timezone arithmetic — only integer slot math relative to
// `week.startMs` and the supplied day boundaries.

import type {
  Car,
  DayBounds,
  Destination,
  LegCarMode,
  LegSide,
  Passengers,
  Request,
  SolverConfig,
  SolverInput,
  Window,
} from './types';
import { fits } from './seatFit';

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

function travelSlotsFor(destination: Destination | undefined, config: SolverConfig): number {
  const minutes = destination?.travelMinutes ?? config.defaultTravelMinutes;
  return Math.max(1, Math.ceil(minutes / 15));
}

function destinationOf(input: SolverInput, id: string): Destination {
  return input.destinations[id] ?? { id, zone: 'unknown' };
}

/** Builds the fallback/only 'both' (keep) leg of a round trip: the car block starts and
 * ends at home; the requester's travel to the destination is recorded on the
 * AssignmentLeg, not on the car block itself. */
function buildKeepLeg(home: string, D: number, R: number): NormalizedLeg {
  return { side: 'both', preferredMode: 'keep', originId: home, destinationId: home, window: { start: D, end: R } };
}

/** The independent out-leg of a round trip (used by relay pairing / splitLegs when needsCarAtDestination = false). */
export function roundTripOutLeg(nr: NormalizedRequest, home: string): NormalizedLeg {
  const D = nr.window.start;
  return {
    side: 'out',
    preferredMode: nr.request.oneWayCarMode ?? 'relay',
    originId: home,
    destinationId: nr.destinationId,
    window: { start: D, end: D + nr.travelSlots },
  };
}

/** The independent return-leg of a round trip. */
export function roundTripReturnLeg(nr: NormalizedRequest, home: string): NormalizedLeg {
  const R = nr.window.end;
  return {
    side: 'return',
    preferredMode: nr.request.oneWayCarMode ?? 'relay',
    originId: nr.destinationId,
    destinationId: home,
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
}

/** Builds the same NormalizedRequest shape the main loop's round_trip branch produces — factored out
 *  so a multi-day series' first in-week leg can be scored by the ordinary policy engine (SOLVER §3.x). */
function buildRoundTripNormalized(
  request: Request,
  input: SolverInput,
  home: string,
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
    legs: [buildKeepLeg(home, D, R)],
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
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: 'WARN_TIME_NOT_ALIGNED', requestId: request.id });
        legs.push({
          requestId: request.id,
          request,
          seriesIndex,
          window: { start: 0, end: 0 },
          originId: isGlobalFirst ? home : request.destinationId,
          destinationId: isGlobalLast ? home : request.destinationId,
          passengers: request.passengers,
          luggage: request.luggage,
          dayIndex: 0,
          flexDep: [0, 0],
          flexRet: [0, 0],
        });
        continue;
      }
      if (!isAligned(request.departureMs, input.week.startMs) || !isAligned(request.returnMs, input.week.startMs)) {
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: 'WARN_TIME_NOT_ALIGNED', requestId: request.id });
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
        originId: isGlobalFirst ? home : request.destinationId,
        destinationId: isGlobalLast ? home : request.destinationId,
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
    const travelSlots = travelSlotsFor(destinationOf(input, first.request.destinationId), input.config);
    seriesUnits.push({
      seriesId,
      seriesCount,
      destinationId: first.request.destinationId,
      legs,
      scoreProxy: buildRoundTripNormalized(first.request, input, home, first.window.start, first.window.end, travelSlots),
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
  const sortedRequests = [...input.requests].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const normalized: NormalizedRequest[] = [];
  const seriesRequests: Request[] = [];

  for (const request of sortedRequests) {
    if (servedByFixed.has(request.id)) continue;
    if (request.seriesId !== undefined) {
      seriesRequests.push(request);
      continue;
    }
    const destination = destinationOf(input, request.destinationId);
    const travelSlots = travelSlotsFor(destination, input.config);

    if (input.cars.length > 0 && !input.cars.some((c) => fits(c, request.passengers))) {
      warnings.push({ code: 'NO_CAR_FITS_SEATS', message: 'WARN_NO_CAR_FITS_SEATS', requestId: request.id });
    }

    if (request.tripShape === 'round_trip') {
      if (request.departureMs === undefined || request.returnMs === undefined) {
        // malformed input; skip rather than throw (normalization never throws)
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: 'WARN_TIME_NOT_ALIGNED', requestId: request.id });
        continue;
      }
      if (!isAligned(request.departureMs, input.week.startMs) || !isAligned(request.returnMs, input.week.startMs)) {
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: 'WARN_TIME_NOT_ALIGNED', requestId: request.id });
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
        legs: [buildKeepLeg(home, D, R)],
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
      });
      continue;
    }

    // One-way shapes: durationFixed = true (single shift dimension).
    let mode = request.oneWayCarMode;
    if (mode === undefined) {
      warnings.push({ code: 'ONE_WAY_MODE_MISSING', message: 'WARN_ONE_WAY_MODE_MISSING', requestId: request.id });
      mode = 'passenger';
    }

    if (request.tripShape === 'one_way_to') {
      if (request.departureMs === undefined) continue;
      if (!isAligned(request.departureMs, input.week.startMs)) {
        warnings.push({ code: 'TIME_NOT_ALIGNED', message: 'WARN_TIME_NOT_ALIGNED', requestId: request.id });
      }
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
        legs: [{ side: 'out', preferredMode: mode, originId: home, destinationId: request.destinationId, window }],
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
      });
      continue;
    }

    // one_way_from
    if (request.returnMs === undefined) continue;
    if (!isAligned(request.returnMs, input.week.startMs)) {
      warnings.push({ code: 'TIME_NOT_ALIGNED', message: 'WARN_TIME_NOT_ALIGNED', requestId: request.id });
    }
    const R = toSlotCeil(request.returnMs, input.week.startMs);
    const day = dayBoundsForSlot(input.week.days, toSlotFloor(request.returnMs, input.week.startMs));
    const dayWindow = requestDayWindow(request, day, input.week.startMs);
    const flexRet: [number, number] = [
      resolveFlexBound(R, request.flexReturn.earlierMin, 'earlier', day),
      resolveFlexBound(R, request.flexReturn.laterMin, 'later', day),
    ];
    const window = mode === 'relay' ? { start: R - travelSlots, end: R } : { start: R, end: R };
    normalized.push({
      id: request.id,
      request,
      legs: [{ side: 'return', preferredMode: mode, originId: request.destinationId, destinationId: home, window }],
      window,
      minDurationSlots: mode === 'relay' ? Math.max(1, travelSlots) : 0,
      flexDep: [R, R],
      flexRet: boundedFlex(flexRet, dayWindow),
      durationFixed: true,
      travelSlots,
      passengers: request.passengers,
      luggage: request.luggage,
      destinationId: request.destinationId,
      dayIndex: day.dayIndex,
      dayWindow,
      isPassengerOnly: mode === 'passenger',
    });
  }

  const seriesUnits = buildSeriesUnits(seriesRequests, input, warnings);

  return { normalized, servedByFixed, warnings, seriesUnits };
}

/** Total-order request id comparator used everywhere as the final tie-break (determinism). */
export function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function carsById(cars: Car[]): Map<string, Car> {
  return new Map(cars.map((c) => [c.id, c]));
}
