import { describe, expect, it } from 'vitest';
import { manualBoost } from '../manualBoost';
import { normalize } from '../../slots';
import { baseInput, makeCar, makeRequest, slotMs } from '../../__fixtures__/gen';

function ctx() {
  return { params: {}, policy: { id: '', version: 1, rules: [] }, stats: { fairness: {}, usualCarId: {} }, destinations: {}, batch: { requests: [], size: 0 } };
}
function nrWithBoost(value?: number) {
  const input = baseInput({
    cars: [makeCar('C1')],
    requests: [makeRequest({ departureMs: slotMs(32), returnMs: slotMs(48), manualBoost: value === undefined ? undefined : { value, reason: 'because' } })],
  });
  return normalize(input).normalized[0]!;
}

describe('rules/manualBoost', () => {
  it('defaults to 0 when no boost is set', () => {
    expect(manualBoost.score(ctx(), nrWithBoost())).toBe(0);
  });

  it('reads the request-level boost value directly', () => {
    expect(manualBoost.score(ctx(), nrWithBoost(0.8))).toBe(0.8);
  });

  it('validateParams always accepts (no params)', () => {
    expect(manualBoost.validateParams(null)).toEqual({});
  });
});
