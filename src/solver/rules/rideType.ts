// src/solver/rules/rideType.ts
import { ruleDescription } from '../reasons';
import { PolicyParamsError } from '../types';
import type { Rule } from './types';

export interface RideTypeParams {
  /** keyed by `ride_types.code` — any string key is accepted; the set of codes is admin data, not fixed at compile time */
  weights: Record<string, number>;
  /** applied to a ride type absent from `weights` (e.g. a code added after this policy version was saved) */
  defaultWeight: number;
}

/** Seed default: the five ride types shipped in supabase/seed.sql, kept so stored policies from before this
 *  change (which never had `defaultWeight`) keep validating — see validateParams below. */
const DEFAULT_WEIGHT = 5;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegativeFinite(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

export const rideType: Rule<RideTypeParams> = {
  type: 'rideType',
  normalization: 'unit',
  defaultParams: {
    weights: { healthcare: 10, work: 8, childcare: 8, other: 5, errands: 3 },
    defaultWeight: DEFAULT_WEIGHT,
  },
  validateParams(raw) {
    if (typeof raw !== 'object' || raw === null || !('weights' in raw)) {
      throw new PolicyParamsError('RIDETYPE_WEIGHTS_INVALID');
    }
    const weights = (raw as { weights: unknown }).weights;
    if (typeof weights !== 'object' || weights === null || Array.isArray(weights)) {
      throw new PolicyParamsError('RIDETYPE_WEIGHTS_INVALID');
    }
    const entries = Object.entries(weights as Record<string, unknown>);
    for (const [, v] of entries) {
      if (!isNonNegativeFinite(v)) throw new PolicyParamsError('RIDETYPE_WEIGHTS_INVALID');
    }
    // Older stored policies (before defaultWeight existed) had no such key; default it so they keep validating.
    const rawDefaultWeight = (raw as { defaultWeight?: unknown }).defaultWeight;
    const defaultWeight = rawDefaultWeight === undefined ? DEFAULT_WEIGHT : rawDefaultWeight;
    if (!isNonNegativeFinite(defaultWeight)) throw new PolicyParamsError('RIDETYPE_DEFAULTWEIGHT_INVALID');
    return { weights: Object.fromEntries(entries as [string, number][]), defaultWeight };
  },
  describe() {
    return ruleDescription('RULE_RIDETYPE_DESC');
  },
  score(ctx, request) {
    const { weights, defaultWeight } = ctx.params;
    const max = Math.max(defaultWeight, ...Object.values(weights));
    if (max <= 0) return 0;
    const w = weights[request.request.rideType] ?? defaultWeight;
    return w / max;
  },
};
