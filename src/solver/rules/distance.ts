// src/solver/rules/distance.ts
import { ruleDescription } from '../reasons';
import { originIdOf, travelBetween } from '../travel';
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
    // `homeLocationId`/`config` are optional on RuleContext for backward
    // compatibility with hand-built test contexts that predate origins
    // (REQUIREMENTS §13.93) — absent either, fall back to the pre-origin
    // behavior of reading the destination's own `distanceKm` directly.
    if (ctx.homeLocationId === undefined || ctx.config === undefined) {
      const km = ctx.destinations[request.destinationId]?.distanceKm;
      return km === undefined ? 0 : Math.min(km / ctx.params.maxKm, 1);
    }
    const origin = originIdOf(request.request, ctx.homeLocationId);
    const { km } = travelBetween(
      { travel: ctx.travel, homeLocationId: ctx.homeLocationId, destinations: ctx.destinations, config: ctx.config },
      origin,
      request.destinationId,
    );
    if (km === undefined) return 0;
    return Math.min(km / ctx.params.maxKm, 1);
  },
};
