import type { PlacedSingle, Unit } from './greedy';
import type { CarTimeline } from './timeline';
import type { Relocation, SolverInput, Suggestion } from './types';
export interface ImproveResult {
    newlyPlaced: PlacedSingle[];
    stillUnmetUnits: Unit[];
    relocationsApplied: Relocation[];
    ejectionSuggestions: Map<string, Suggestion>;
    budgetExhausted: boolean;
}
export declare function runImprove(unmetUnits: Unit[], placedSingles: PlacedSingle[], timelines: Map<string, CarTimeline>, input: SolverInput, scores: Map<string, {
    total: number;
}>): ImproveResult;
