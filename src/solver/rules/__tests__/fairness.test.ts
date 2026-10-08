import { describe, expect, it } from 'vitest';
import { alternativeServedWeightOf, fairness } from '../fairness';
import { PolicyParamsError } from '../../types';
import { normalize } from '../../slots';
import { baseInput, makeCar, makeRequest, slotMs } from '../../__fixtures__/gen';

function ctx(fairnessStats: Record<string, { deficit: number }>) {
  return { params: { lookbackWeeks: 3 }, policy: { id: '', version: 1, rules: [] }, stats: { fairness: fairnessStats, usualCarId: {} }, destinations: {}, batch: { requests: [], size: 0 } };
}
function nrOf(memberId: string) {
  const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ memberId, departureMs: slotMs(32), returnMs: slotMs(48) })] });
  return normalize(input).normalized[0]!;
}

describe('rules/fairness', () => {
  it('reads the caller-supplied deficit for the member', () => {
    expect(fairness.score(ctx({ m1: { deficit: 0.9 } }), nrOf('m1'))).toBe(0.9);
  });

  it('defaults to 0.5 when the member has no stats entry', () => {
    expect(fairness.score(ctx({}), nrOf('unknown'))).toBe(0.5);
  });

  it('validateParams rejects a non-positive lookbackWeeks', () => {
    expect(() => fairness.validateParams({ lookbackWeeks: 0 })).toThrow(PolicyParamsError);
  });

  it('default lookback is 3 weeks (REQ §13.18)', () => {
    expect(fairness.defaultParams.lookbackWeeks).toBe(3);
  });

  it('plan-B served weight (REQ §13.112 a): default 0.1, optional, validated 0..1', () => {
    expect(fairness.defaultParams.alternativeServedWeight).toBe(0.1);
    expect(fairness.validateParams({ lookbackWeeks: 3 })).toEqual({ lookbackWeeks: 3, alternativeServedWeight: 0.1 });
    expect(fairness.validateParams({ lookbackWeeks: 3, alternativeServedWeight: 0.25 }).alternativeServedWeight).toBe(0.25);
    expect(() => fairness.validateParams({ lookbackWeeks: 3, alternativeServedWeight: 1.5 })).toThrow(PolicyParamsError);
    expect(() => fairness.validateParams({ lookbackWeeks: 3, alternativeServedWeight: -0.1 })).toThrow(PolicyParamsError);
  });

  it('alternativeServedWeightOf reads the policy fairness rule and never throws', () => {
    const rules = (params: unknown) => ({ rules: [{ type: 'fairness', weight: 1, params }] });
    expect(alternativeServedWeightOf(rules({ lookbackWeeks: 3, alternativeServedWeight: 0.3 }))).toBe(0.3);
    expect(alternativeServedWeightOf(rules({ lookbackWeeks: 3 }))).toBe(0.1);
    expect(alternativeServedWeightOf(rules({ lookbackWeeks: 3, alternativeServedWeight: 7 }))).toBe(0.1);
    expect(alternativeServedWeightOf({ rules: [] })).toBe(0.1);
  });
});
