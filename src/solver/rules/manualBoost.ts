// src/solver/rules/manualBoost.ts
import { ruleDescription } from '../reasons';
import type { Rule } from './types';

export type ManualBoostParams = Record<string, never>;

export const manualBoost: Rule<ManualBoostParams> = {
  type: 'manualBoost',
  normalization: 'unit',
  defaultParams: {},
  validateParams() {
    return {};
  },
  describe() {
    return ruleDescription('RULE_MANUALBOOST_DESC');
  },
  score(_ctx, request) {
    return request.request.manualBoost?.value ?? 0;
  },
};
