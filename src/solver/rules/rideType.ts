// src/solver/rules/rideType.ts
import { ruleDescription } from '../reasons';
import { PolicyParamsError } from '../types';
import type { Rule } from './types';

export interface RideTypeParams {
  weights: Record<string, number>;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export const rideType: Rule<RideTypeParams> = {
  type: 'rideType',
  normalization: 'unit',
  defaultParams: { weights: { healthcare: 10, work: 8, childcare: 8, other: 5, errands: 3 } },
  validateParams(raw) {
    if (typeof raw !== 'object' || raw === null || !('weights' in raw)) {
      throw new PolicyParamsError('RIDETYPE_WEIGHTS_INVALID');
    }
    const weights = (raw as { weights: unknown }).weights;
    if (typeof weights !== 'object' || weights === null) throw new PolicyParamsError('RIDETYPE_WEIGHTS_INVALID');
    const entries = Object.entries(weights as Record<string, unknown>);
    for (const [, v] of entries) {
      if (!isFiniteNumber(v) || v < 0) throw new PolicyParamsError('RIDETYPE_WEIGHTS_INVALID');
    }
    return { weights: Object.fromEntries(entries as [string, number][]) };
  },
  describe() {
    return ruleDescription('RULE_RIDETYPE_DESC');
  },
  score(ctx, request) {
    const { weights } = ctx.params;
    const values = Object.values(weights);
    const max = values.length > 0 ? Math.max(...values) : 0;
    if (max <= 0) return 0;
    const w = weights[request.request.rideType];
    if (w === undefined) return 0;
    return w / max;
  },
};
