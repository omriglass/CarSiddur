// src/solver/rules/distance.ts
import { ruleDescription } from '../reasons';
import { PolicyParamsError } from '../types';
import type { Rule } from './types';

export interface DistanceParams {
  maxKm: number;
}

export const distance: Rule<DistanceParams> = {
  type: 'distance',
  normalization: 'unit',
  defaultParams: { maxKm: 60 },
  validateParams(raw) {
    if (typeof raw !== 'object' || raw === null || !('maxKm' in raw)) throw new PolicyParamsError('DISTANCE_MAXKM_INVALID');
    const maxKm = (raw as { maxKm: unknown }).maxKm;
    if (typeof maxKm !== 'number' || !Number.isFinite(maxKm) || maxKm <= 0) {
      throw new PolicyParamsError('DISTANCE_MAXKM_INVALID');
    }
    return { maxKm };
  },
  describe() {
    return ruleDescription('RULE_DISTANCE_DESC');
  },
  score(ctx, request) {
    const dest = ctx.destinations[request.destinationId];
    const km = dest?.distanceKm;
    if (km === undefined) return 0;
    return Math.min(km / ctx.params.maxKm, 1);
  },
};
