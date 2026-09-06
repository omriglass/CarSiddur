import type { NormalizedRequest, Warning } from '../slots';
import { type SolverInput } from '../types';
export interface ScoreBreakdown {
    total: number;
    perRule: {
        type: string;
        raw: number;
        normalized: number;
        weight: number;
        contribution: number;
    }[];
}
export interface ScoreResult {
    scores: Map<string, ScoreBreakdown>;
    warnings: Warning[];
}
export declare function scoreRequests(input: SolverInput, batch: NormalizedRequest[], relayPairPeople?: Map<string, number>): ScoreResult;
