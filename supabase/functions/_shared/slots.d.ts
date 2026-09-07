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
export interface NormalizeResult {
    normalized: NormalizedRequest[];
    servedByFixed: Set<string>;
    warnings: Warning[];
}
export declare function normalize(input: SolverInput): NormalizeResult;
/** Total-order request id comparator used everywhere as the final tie-break (determinism). */
export declare function byId<T extends {
    id: string;
}>(a: T, b: T): number;
export declare function carsById(cars: Car[]): Map<string, Car>;
