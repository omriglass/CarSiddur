// src/solver/rules/fairness.ts
import { ruleDescription } from '../reasons';
import type { Rule } from './types';
import { validatePositiveNumberParam } from './types';

export interface FairnessParams {
  lookbackWeeks: number;
}

export const fairness: Rule<FairnessParams> = {
  type: 'fairness',
  normalization: 'unit',
  defaultParams: { lookbackWeeks: 3 },
  validateParams(raw) {
    return { lookbackWeeks: validatePositiveNumberParam(raw, 'lookbackWeeks', 'FAIRNESS_LOOKBACK_INVALID') };
  },
  describe() {
    return ruleDescription('RULE_FAIRNESS_DESC');
  },
  score(ctx, request) {
    const entry = ctx.stats.fairness[request.request.memberId];
    return entry?.deficit ?? 0.5;
  },
};
