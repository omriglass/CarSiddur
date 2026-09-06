import type { NormalizedRequest } from '../slots';
import type { Destination, Policy, SolverStats } from '../types';
export interface RuleContext<P> {
    params: P;
    policy: Policy;
    stats: SolverStats;
    destinations: Record<string, Destination>;
    /** for batch-relative rules (e.g. minmax normalization, submission rank) */
    batch: {
        requests: NormalizedRequest[];
        size: number;
        /** requestId -> combined people count of both legs of its relay pair, when paired (SOLVER §3.5, §3.6.1) */
        relayPairPeople?: Map<string, number>;
    };
}
export interface Rule<P = unknown> {
    type: string;
    /** 'unit': raw value already in 0..1 (clamped); 'minmax': scaled across the batch */
    normalization: 'unit' | 'minmax';
    defaultParams: P;
    /** throws PolicyParamsError(code); Hebrew text rendered from reasons.ts */
    validateParams(raw: unknown): P;
    /** Hebrew for the admin UI, rendered via reasons.ts (RULE_<TYPE>_DESC) */
    describe(params: P): string;
    /** raw value, not yet normalized or weighted */
    score(ctx: RuleContext<P>, request: NormalizedRequest): number;
}
