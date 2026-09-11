// src/solver/rules/distance.ts
import { ruleDescription } from '../reasons';
import type { Rule } from './types';
import { validatePositiveNumberParam } from './types';

export interface DistanceParams {
  maxKm: number;
}

export const distance: Rule<DistanceParams> = {
  type: 'distance',
  normalization: 'unit',
  defaultParams: { maxKm: 60 },
  validateParams(raw) {
    return { maxKm: validatePositiveNumberParam(raw, 'maxKm', 'DISTANCE_MAXKM_INVALID') };
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
