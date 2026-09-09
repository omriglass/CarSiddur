import { describe, expect, it } from 'vitest';
import { rideType } from '../rideType';
import { PolicyParamsError } from '../../types';
import { normalize } from '../../slots';
import { baseInput, makeCar, makeRequest, slotMs } from '../../__fixtures__/gen';

function ctx(params = rideType.defaultParams) {
  return { params, policy: { id: '', version: 1, rules: [] }, stats: { fairness: {}, usualCarId: {} }, destinations: {}, batch: { requests: [], size: 0 } };
}

function nrOf(rideTypeValue: string) {
  const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ rideType: rideTypeValue, departureMs: slotMs(32), returnMs: slotMs(48) })] });
  return normalize(input).normalized[0]!;
}

describe('rules/rideType', () => {
  it('value range: known type / max(weights, defaultWeight)', () => {
    const params = { weights: { work: 8, healthcare: 10 }, defaultWeight: 5 };
    expect(rideType.score(ctx(params), nrOf('healthcare'))).toBe(1);
    expect(rideType.score(ctx(params), nrOf('work'))).toBe(0.8);
  });

  it('unknown ride type falls back to defaultWeight', () => {
    const params = { weights: { work: 8 }, defaultWeight: 4 };
    // max(8, 4) = 8, so an unknown type scores 4/8 = 0.5 instead of 0
    expect(rideType.score(ctx(params), nrOf('unknown-type'))).toBe(0.5);
  });

  it('defaultWeight can exceed every specific weight and still normalizes to <= 1', () => {
    const params = { weights: { work: 2 }, defaultWeight: 10 };
    expect(rideType.score(ctx(params), nrOf('unknown-type'))).toBe(1);
    expect(rideType.score(ctx(params), nrOf('work'))).toBe(0.2);
  });

  it('validateParams rejects a missing/invalid weights map', () => {
    expect(() => rideType.validateParams({})).toThrow(PolicyParamsError);
    expect(() => rideType.validateParams({ weights: { work: -1 } })).toThrow(PolicyParamsError);
    expect(() => rideType.validateParams({ weights: 'nope' })).toThrow(PolicyParamsError);
  });

  it('validateParams rejects an invalid defaultWeight', () => {
    expect(() => rideType.validateParams({ weights: { work: 8 }, defaultWeight: -1 })).toThrow(PolicyParamsError);
    expect(() => rideType.validateParams({ weights: { work: 8 }, defaultWeight: 'nope' })).toThrow(PolicyParamsError);
  });

  it('accepts valid params with an explicit defaultWeight', () => {
    expect(rideType.validateParams({ weights: { work: 8 }, defaultWeight: 3 })).toEqual({
      weights: { work: 8 },
      defaultWeight: 3,
    });
  });

  it('accepts params without defaultWeight (older stored policies) and defaults it', () => {
    expect(rideType.validateParams({ weights: { work: 8 } })).toEqual({ weights: { work: 8 }, defaultWeight: 5 });
  });

  it('accepts any string key (admin-defined ride type codes, not a fixed set)', () => {
    expect(rideType.validateParams({ weights: { seniorCare: 7 }, defaultWeight: 5 })).toEqual({
      weights: { seniorCare: 7 },
      defaultWeight: 5,
    });
  });
});
