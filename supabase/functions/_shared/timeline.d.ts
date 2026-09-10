import type { Car, DayBounds, Window } from './types';
export interface Block {
    rideId: string;
    window: Window;
    startLocationId: string;
    endLocationId: string;
    /** true only for a fixed ride the Sadran explicitly acknowledged may leave the car away overnight
     *  (or, generically, for any leg of a multi-day series that leaves the car parked away between legs
     *  — SOLVER §3.x "Multi-day series") */
    overnightAck: boolean;
    approvedBufferAfterSlots?: number;
    /** set for legs of a multi-day series (docs/SOLVER.md §3.x): consecutive legs sharing the same
     *  seriesId are contiguous by construction and need no buffer between them, even though the
     *  ordinary buffer rule still applies against every other block/maintenance entry. */
    seriesId?: string;
}
export interface Gap {
    window: Window;
    locationId: string;
}
export declare class CarTimeline {
    private readonly car;
    private readonly bufferSlots;
    private readonly weekSlots;
    private readonly homeLocationId;
    private blocks;
    private fixedRideIds;
    private maintenance;
    private readonly startLocation;
    constructor(car: Car, bufferSlots: number, weekSlots: number, homeLocationId: string);
    /** Where the car is immediately before `slot` (i.e. in the gap containing `slot`). */
    locationAt(slot: number): string;
    private overlapsAnything;
    /** Free AND the car is at `originId` when `w` starts. */
    isFree(w: Window, originId: string): boolean;
    /** Inserts a block; rejects (throws) one whose start location mismatches the car's actual location. */
    add(b: Block): void;
    /**
     * Inserts a block without checking the location chain (only the buffer/overlap
     * rule still applies) — used only to seed fixed rides, which are "still
     * honoured" even when their recorded origin does not match the car's
     * computed location (SOLVER §3.1, FIXED_RIDE_LOCATION_MISMATCH warning).
     */
    forceAdd(b: Block): void;
    remove(rideId: string): void;
    has(rideId: string): boolean;
    allBlocks(): readonly Block[];
    awayAt(slot: number): boolean;
    /** Free intervals (bounded by the buffer on both sides) with the car's location during each. */
    gaps(): Gap[];
    /**
     * Raw obstacle-to-obstacle gaps, without the buffer margin trimmed off
     * each side — the car is physically present at `location` for the whole
     * interval between two rides, even though a *new* booking could only use
     * the buffer-shrunk sub-interval (that's what `gaps()` is for). Used for
     * away-time reporting (carsAway, day-end check), never for placement.
     */
    private rawGaps;
    /** Gaps whose location is not home — for SolverOutput.carsAway. */
    awayWindows(): {
        locationId: string;
        window: Window;
    }[];
    /**
     * Away windows that improperly span a day's dayEndSlot: the car is away at
     * day end and the block that moved it there was not an acknowledged
     * overnight fixed ride (SOLVER §1.3.9, §3.12).
     */
    dayEndViolations(days: DayBounds[]): {
        window: Window;
        causeRideId?: string;
    }[];
}
export declare function buildTimelines(cars: Car[], bufferSlots: number, weekSlots: number, homeLocationId: string): Map<string, CarTimeline>;
