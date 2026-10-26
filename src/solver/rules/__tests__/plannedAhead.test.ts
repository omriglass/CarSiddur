import { describe, expect, it } from 'vitest';
import { plannedAhead } from '../plannedAhead';
import { normalize } from '../../slots';
import { baseInput, makeCar, makeRequest, slotMs } from '../../__fixtures__/gen';
import { PolicyParamsError } from '../../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const FRI_SAT = [false, false, false, false, false, true, true];

function ctx(params = { days: FRI_SAT, minLeadDays: 14 }) {
  return { params, policy: { id: '', version: 1, rules: [] }, stats: { fairness: {}, usualCarId: {} }, destinations: {}, batch: { requests: [], size: 0 } };
}
function nr(planned?: { reservedAtMs: number; weekdays: number[] }) {
  const input = baseInput({
    cars: [makeCar('C1')],
    requests: [makeRequest({ departureMs: slotMs(32), returnMs: slotMs(48), plannedAhead: planned })],
  });
  return normalize(input).normalized[0]!;
}

describe('rules/plannedAhead', () => {
  it('is 0 for a request not filed from a reservation', () => {
    expect(plannedAhead.score(ctx(), nr())).toBe(0);
  });

  it('rewards a reservation made early enough on a selected weekday', () => {
    expect(plannedAhead.score(ctx(), nr({ reservedAtMs: slotMs(32) - 20 * DAY_MS, weekdays: [5] }))).toBe(1);
  });

  it('is 0 when the reservation was made too close to the ride', () => {
    expect(plannedAhead.score(ctx(), nr({ reservedAtMs: slotMs(32) - 3 * DAY_MS, weekdays: [5] }))).toBe(0);
  });

  it('is 0 on a weekday that is not selected; a multi-day request counts when any day is selected', () => {
    expect(plannedAhead.score(ctx(), nr({ reservedAtMs: 0, weekdays: [2] }))).toBe(0);
    expect(plannedAhead.score(ctx(), nr({ reservedAtMs: 0, weekdays: [4, 5] }))).toBe(1);
  });

  it('validates seven boolean days and a non-negative lead', () => {
    expect(plannedAhead.validateParams({ days: FRI_SAT, minLeadDays: 0 })).toEqual({ days: FRI_SAT, minLeadDays: 0 });
    expect(() => plannedAhead.validateParams({ days: [true], minLeadDays: 1 })).toThrow(PolicyParamsError);
    expect(() => plannedAhead.validateParams({ days: FRI_SAT, minLeadDays: -1 })).toThrow(PolicyParamsError);
  });
});
