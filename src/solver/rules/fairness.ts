// src/solver/rules/fairness.ts
import { ruleDescription } from '../reasons';
import { PolicyParamsError, type Policy } from '../types';
import type { Rule } from './types';
import { validatePositiveNumberParam } from './types';

export interface FairnessParams {
  lookbackWeeks: number;
  /**
   * REQ §13.112 (a): how much of a served request a request served by its plan B counts (0..1, default 0.1) — in the
   * fairness history (`fairness_stats()` reads it from the department's active policy) and in the policy score
   * (`alternativeServedWeightOf()`). Not read by `score()`: the deficits arrive precomputed in `stats.fairness`.
   */
  alternativeServedWeight?: number;
}

export const DEFAULT_ALTERNATIVE_SERVED_WEIGHT = 0.1;

function validateWeight(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null || !('alternativeServedWeight' in raw)) return DEFAULT_ALTERNATIVE_SERVED_WEIGHT;
  const value = (raw as Record<string, unknown>).alternativeServedWeight;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new PolicyParamsError('FAIRNESS_ALT_WEIGHT_INVALID');
  }
  return value;
}

export const fairness: Rule<FairnessParams> = {
  type: 'fairness',
  normalization: 'unit',
  defaultParams: { lookbackWeeks: 3, alternativeServedWeight: DEFAULT_ALTERNATIVE_SERVED_WEIGHT },
  validateParams(raw) {
    return {
      lookbackWeeks: validatePositiveNumberParam(raw, 'lookbackWeeks', 'FAIRNESS_LOOKBACK_INVALID'),
      alternativeServedWeight: validateWeight(raw),
    };
  },
  describe() {
    return ruleDescription('RULE_FAIRNESS_DESC');
  },
  score(ctx, request) {
    const entry = ctx.stats.fairness[request.request.memberId];
    return entry?.deficit ?? 0.5;
  },
};

/** The plan-B served weight of a policy (its fairness rule's param, else 0.1); never throws on a malformed value. */
export function alternativeServedWeightOf(policy: Pick<Policy, 'rules'>): number {
  const rule = policy.rules.find((r) => r.type === 'fairness');
  const raw = (rule?.params as { alternativeServedWeight?: unknown } | undefined)?.alternativeServedWeight;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_ALTERNATIVE_SERVED_WEIGHT;
}
