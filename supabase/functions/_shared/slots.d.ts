import type { Car, DayBounds, LegCarMode, LegSide, Passengers, Request, SolverInput, Window } from './types';
export declare const SLOT_MS: number;
export declare function toSlotFloor(ms: number, weekStartMs: number): number;
export declare function toSlotCeil(ms: number, weekStartMs: number): number;
export declare function isAligned(ms: number, weekStartMs: number): boolean;
/** minutes represented by a signed slot delta */
export declare function slotsToMinutes(slots: number): number;
export declare function minutesToSlots(minutes: number): number;
/** Finds the DayBounds containing `slot`; falls back to the last day if out of range. */
export declare function dayBoundsForSlot(days: DayBounds[], slot: number): DayBounds;
/** Pure arithmetic HH:MM formatting of a slot's time-of-day (no Date/timezone APIs). */
export declare function formatSlotTime(slot: number, day: DayBounds): string;
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
export declare function withinRequestDay(nr: NormalizedRequest, window: Window): boolean;
export interface Warning {
    code: string;
    message: string;
    requestId?: string;
}
/** The independent out-leg of a round trip (used by relay pairing / splitLegs when needsCarAtDestination = false). */
export declare function roundTripOutLeg(nr: NormalizedRequest, home: string): NormalizedLeg;
/** The independent return-leg of a round trip. */
export declare function roundTripReturnLeg(nr: NormalizedRequest, home: string): NormalizedLeg;
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
export declare function normalize(input: SolverInput): NormalizeResult;
/** Total-order request id comparator used everywhere as the final tie-break (determinism). */
export declare function byId<T extends {
    id: string;
}>(a: T, b: T): number;
export declare function carsById(cars: Car[]): Map<string, Car>;
