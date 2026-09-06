import { describe, expect, it } from 'vitest';
import { flexibilityOffered } from '../flexibilityOffered';
import { PolicyParamsError } from '../../types';
import { normalize } from '../../slots';
import { baseInput, flex, makeCar, makeRequest, noFlex, slotMs } from '../../__fixtures__/gen';

function ctx(params = flexibilityOffered.defaultParams) {
  return { params, policy: { id: '', version: 1, rules: [] }, stats: { fairness: {}, usualCarId: {} }, destinations: {}, batch: { requests: [], size: 0 } };
}
function nrWithFlex(flexDeparture = noFlex(), flexReturn = noFlex()) {
  const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ departureMs: slotMs(32), returnMs: slotMs(48), flexDeparture, flexReturn })] });
  return normalize(input).normalized[0]!;
}

describe('rules/flexibilityOffered', () => {
  it('no declared flexibility scores 0', () => {
    expect(flexibilityOffered.score(ctx(), nrWithFlex())).toBe(0);
  });

  it('sums all four sides, capped at fullCreditMinutes', () => {
    const nr = nrWithFlex(flex(30, 30), flex(30, 30)); // 120 min total
    expect(flexibilityOffered.score(ctx({ fullCreditMinutes: 240 }), nr)).toBeCloseTo(0.5);
  });

  it('"day" counts as 480 minutes', () => {
    const nr = nrWithFlex(flex('day', 0), noFlex());
    expect(flexibilityOffered.score(ctx({ fullCreditMinutes: 480 }), nr)).toBe(1);
  });

  it('validateParams rejects a non-positive fullCreditMinutes', () => {
    expect(() => flexibilityOffered.validateParams({ fullCreditMinutes: 0 })).toThrow(PolicyParamsError);
  });
});
