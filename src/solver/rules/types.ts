// src/solver/rules/types.ts
//
// Rule interface and context (docs/SOLVER.md §4.1). Rule files contain no
// Hebrew: descriptions and param-error messages are rendered from
// src/solver/reasons.ts via ruleDescription()/PolicyParamsError.

import type { NormalizedRequest } from '../slots';
import { PolicyParamsError, type Destination, type Policy, type SolverConfig, type SolverStats, type TravelEdge } from '../types';

export interface RuleContext<P> {
  params: P;
  policy: Policy;
  stats: SolverStats;
  destinations: Record<string, Destination>;
  /**
   * Department home (REQUIREMENTS §13.93); use with `originIdOf()`/
   * `travelBetween()`, never compare directly. Optional for backward
   * compatibility with hand-built contexts (rule unit tests) that predate
   * origins — every rule that needs it (currently only `distance`) treats an
   * absent value as "no origin resolution available" and degrades gracefully.
   */
  homeLocationId?: string;
  travel?: TravelEdge[];
  config?: Pick<SolverConfig, 'defaultTravelMinutes'>;
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

/**
 * Shared `validateParams` building block for the (common) single-numeric-param
 * rule shape: `raw` must be an object carrying a finite number at `key`,
 * positive by default. Pass `{ allowZero: true }` for a rule whose param may
 * legitimately be zero (e.g. `submissionTime`'s `latePenalty`). Throws
 * `PolicyParamsError(errorCode)` — Hebrew text for `errorCode` lives in
 * `reasons.ts` — on any other shape.
 */
export function validatePositiveNumberParam(
  raw: unknown,
  key: string,
  errorCode: string,
  options?: { allowZero?: boolean },
): number {
  if (typeof raw !== 'object' || raw === null || !(key in raw)) throw new PolicyParamsError(errorCode);
  const value = (raw as Record<string, unknown>)[key];
  const invalid = typeof value !== 'number' || !Number.isFinite(value) || (options?.allowZero ? value < 0 : value <= 0);
  if (invalid) throw new PolicyParamsError(errorCode);
  return value;
}
