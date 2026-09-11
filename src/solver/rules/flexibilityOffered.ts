// src/solver/rules/flexibilityOffered.ts
import { ruleDescription } from '../reasons';
import type { Flexibility } from '../types';
import type { Rule } from './types';
import { validatePositiveNumberParam } from './types';

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
    return {
      fullCreditMinutes: validatePositiveNumberParam(raw, 'fullCreditMinutes', 'FLEXIBILITYOFFERED_MINUTES_INVALID'),
    };
  },
  describe() {
    return ruleDescription('RULE_FLEXIBILITYOFFERED_DESC');
  },
  score(ctx, request) {
    const total = totalMinutes(request.request.flexDeparture) + totalMinutes(request.request.flexReturn);
    return Math.min(total / ctx.params.fullCreditMinutes, 1);
  },
};
