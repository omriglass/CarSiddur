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
  it('value range: known type / max(weights)', () => {
    const params = { weights: { work: 8, healthcare: 10 } };
    expect(rideType.score(ctx(params), nrOf('healthcare'))).toBe(1);
    expect(rideType.score(ctx(params), nrOf('work'))).toBe(0.8);
  });

  it('unknown ride type scores 0', () => {
    const params = { weights: { work: 8 } };
    expect(rideType.score(ctx(params), nrOf('unknown-type'))).toBe(0);
  });

  it('validateParams rejects a missing/invalid weights map', () => {
    expect(() => rideType.validateParams({})).toThrow(PolicyParamsError);
    expect(() => rideType.validateParams({ weights: { work: -1 } })).toThrow(PolicyParamsError);
    expect(() => rideType.validateParams({ weights: 'nope' })).toThrow(PolicyParamsError);
  });

  it('accepts valid params', () => {
    expect(rideType.validateParams({ weights: { work: 8 } })).toEqual({ weights: { work: 8 } });
  });
});
