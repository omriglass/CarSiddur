// src/solver/rules/fairness.ts
import { ruleDescription } from '../reasons';
import { PolicyParamsError } from '../types';
import type { Rule } from './types';

export interface FairnessParams {
  lookbackWeeks: number;
}

export const fairness: Rule<FairnessParams> = {
  type: 'fairness',
  normalization: 'unit',
  defaultParams: { lookbackWeeks: 3 },
  validateParams(raw) {
    if (typeof raw !== 'object' || raw === null || !('lookbackWeeks' in raw)) {
      throw new PolicyParamsError('FAIRNESS_LOOKBACK_INVALID');
    }
    const lookbackWeeks = (raw as { lookbackWeeks: unknown }).lookbackWeeks;
    if (typeof lookbackWeeks !== 'number' || !Number.isFinite(lookbackWeeks) || lookbackWeeks <= 0) {
      throw new PolicyParamsError('FAIRNESS_LOOKBACK_INVALID');
    }
    return { lookbackWeeks };
  },
  describe() {
    return ruleDescription('RULE_FAIRNESS_DESC');
  },
  score(ctx, request) {
    const entry = ctx.stats.fairness[request.request.memberId];
    return entry?.deficit ?? 0.5;
  },
};
