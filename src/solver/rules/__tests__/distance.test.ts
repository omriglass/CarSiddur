import { describe, expect, it } from 'vitest';
import { distance } from '../distance';
import { PolicyParamsError } from '../../types';
import { normalize } from '../../slots';
import { baseInput, makeCar, makeRequest, slotMs } from '../../__fixtures__/gen';

function ctx(params = distance.defaultParams, destinations = {}) {
  return { params, policy: { id: '', version: 1, rules: [] }, stats: { fairness: {}, usualCarId: {} }, destinations, batch: { requests: [], size: 0 } };
}

function nrAt(destinationId: string) {
  const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ destinationId, departureMs: slotMs(32), returnMs: slotMs(48) })] });
  return normalize(input).normalized[0]!;
}

describe('rules/distance', () => {
  it('scales distanceKm / maxKm, capped at 1', () => {
    const destinations = { destA: { id: 'destA', zone: 'z', distanceKm: 30 } };
    expect(distance.score(ctx({ maxKm: 60 }, destinations), nrAt('destA'))).toBe(0.5);
    expect(distance.score(ctx({ maxKm: 10 }, destinations), nrAt('destA'))).toBe(1);
  });

  it('unknown distance scores 0', () => {
    const destinations = { destA: { id: 'destA', zone: 'z' } };
    expect(distance.score(ctx({ maxKm: 60 }, destinations), nrAt('destA'))).toBe(0);
  });

  it('validateParams rejects a non-positive maxKm', () => {
    expect(() => distance.validateParams({ maxKm: 0 })).toThrow(PolicyParamsError);
    expect(() => distance.validateParams({})).toThrow(PolicyParamsError);
  });
});
