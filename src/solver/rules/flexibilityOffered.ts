// src/solver/rules/flexibilityOffered.ts
import { ruleDescription } from '../reasons';
import { PolicyParamsError } from '../types';
import type { Flexibility } from '../types';
import type { Rule } from './types';

export interface FlexibilityOfferedParams {
  fullCreditMinutes: number;
}

const DAY_CREDIT_MINUTES = 480;

function minutesOf(v: number | 'day'): number {
  return v === 'day' ? DAY_CREDIT_MINUTES : v;
}

function totalMinutes(f: Flexibility): number {
  return minutesOf(f.earlierMin) + minutesOf(f.laterMin);
}

export const flexibilityOffered: Rule<FlexibilityOfferedParams> = {
  type: 'flexibilityOffered',
  normalization: 'unit',
  defaultParams: { fullCreditMinutes: 240 },
  validateParams(raw) {
    if (typeof raw !== 'object' || raw === null || !('fullCreditMinutes' in raw)) {
      throw new PolicyParamsError('FLEXIBILITYOFFERED_MINUTES_INVALID');
    }
    const fullCreditMinutes = (raw as { fullCreditMinutes: unknown }).fullCreditMinutes;
    if (typeof fullCreditMinutes !== 'number' || !Number.isFinite(fullCreditMinutes) || fullCreditMinutes <= 0) {
      throw new PolicyParamsError('FLEXIBILITYOFFERED_MINUTES_INVALID');
    }
    return { fullCreditMinutes };
  },
  describe() {
    return ruleDescription('RULE_FLEXIBILITYOFFERED_DESC');
  },
  score(ctx, request) {
    const total = totalMinutes(request.request.flexDeparture) + totalMinutes(request.request.flexReturn);
    return Math.min(total / ctx.params.fullCreditMinutes, 1);
  },
};
