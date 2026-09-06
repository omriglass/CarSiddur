import type { RelayPair } from './relay';
import { type NormalizedRequest } from './slots';
import { CarTimeline } from './timeline';
import type { Assignment, Car, SolverInput, Window } from './types';
export interface Unit {
    kind: 'single' | 'pair';
    id: string;
    score: number;
    submittedAtMs: number;
    single?: NormalizedRequest;
    pair?: {
        pair: RelayPair;
        outNr: NormalizedRequest;
        retNr: NormalizedRequest;
    };
}
export declare function buildUnits(roundTrips: NormalizedRequest[], pairs: RelayPair[], byRequestId: Map<string, NormalizedRequest>, scores: Map<string, {
    total: number;
}>): Unit[];
export declare function sortUnits(units: Unit[]): Unit[];
export interface PlacedSingle {
    kind: 'single';
    nr: NormalizedRequest;
    carId: string;
    window: Window;
    shift: {
        departureMin: number;
        returnMin: number;
    };
}
export interface PlacedPair {
    kind: 'pair';
    pair: RelayPair;
    outNr: NormalizedRequest;
    retNr: NormalizedRequest;
    carId: string;
}
export type Placed = PlacedSingle | PlacedPair;
export interface GreedyResult {
    placed: Placed[];
    unmetUnits: Unit[];
}
/** Runs the ordered greedy pass, mutating `timelines` in place for every unit it places. */
export declare function runGreedy(units: Unit[], timelines: Map<string, CarTimeline>, input: SolverInput): GreedyResult;
/** Renders Assignment objects for a greedy result; does not touch timelines. */
export declare function toAssignments(placed: Placed[], input: SolverInput, carsById: Map<string, Car>): Assignment[];
