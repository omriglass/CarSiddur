import { type NormalizedRequest } from './slots';
import { CarTimeline } from './timeline';
import type { Assignment, SolverInput, Suggestion } from './types';
export interface SuggestionContext {
    input: SolverInput;
    assignments: Assignment[];
    timelines: Map<string, CarTimeline>;
    hostDriverRequests: Map<string, NormalizedRequest>;
    unpairedRelay: NormalizedRequest[];
    ejectionSuggestions: Map<string, Suggestion>;
}
export declare function buildSuggestions(nr: NormalizedRequest, ctx: SuggestionContext, blockerCarIds: string[]): Suggestion[];
