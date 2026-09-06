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
  /** one-way passenger mode: the solver never places this itself; it is served only via merge/chauffeur suggestions */
  isPassengerOnly: boolean;
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

export interface NormalizeResult {
  normalized: NormalizedRequest[];
  servedByFixed: Set<string>;
  warnings: Warning[];
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

  for (const request of sortedRequests) {
    if (servedByFixed.has(request.id)) continue;
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
        flexDep,
        flexRet,
        durationFixed: false,
        travelSlots,
        passengers: request.passengers,
        luggage: request.luggage,
        destinationId: request.destinationId,
        dayIndex: day.dayIndex,
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
        flexDep,
        flexRet: [D, D],
        durationFixed: true,
        travelSlots,
        passengers: request.passengers,
        luggage: request.luggage,
        destinationId: request.destinationId,
        dayIndex: day.dayIndex,
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
    const day = dayBoundsForSlot(input.week.days, R);
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
      flexRet,
      durationFixed: true,
      travelSlots,
      passengers: request.passengers,
      luggage: request.luggage,
      destinationId: request.destinationId,
      dayIndex: day.dayIndex,
      isPassengerOnly: mode === 'passenger',
    });
  }

  return { normalized, servedByFixed, warnings };
}

/** Total-order request id comparator used everywhere as the final tie-break (determinism). */
export function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function carsById(cars: Car[]): Map<string, Car> {
  return new Map(cars.map((c) => [c.id, c]));
}
