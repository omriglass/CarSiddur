import { type NormalizedRequest } from './slots';
import type { CarTimeline } from './timeline';
import type { Assignment, Car, Destination, SolverConfig } from './types';
export interface SplitLegsContext {
    destinations: Record<string, Destination>;
    config: SolverConfig;
    cars: Map<string, Car>;
    assignments: Assignment[];
    hostDriverRequests: Map<string, NormalizedRequest>;
    /** final car timelines, keyed by carId */
    timelines: Map<string, CarTimeline>;
    /** relay one-way requests relay.ts could not pair (still available as split-leg partners) */
    unpairedRelay: NormalizedRequest[];
    home: string;
}
export interface SplitLegSide {
    hostRideId?: string;
    carMode: 'passenger' | 'relay';
    slot: number;
    carId?: string;
}
export interface SplitLegResult {
    outbound: SplitLegSide;
    return: SplitLegSide;
    cost: number;
    confidence: number;
}
/** Tries the four combinations in order; returns the first that succeeds, or null. */
export declare function trySplitLegs(nr: NormalizedRequest, ctx: SplitLegsContext): SplitLegResult | null;
