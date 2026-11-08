import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { matchFreedSlot } from '../live';
import { CarTimeline } from '../timeline';
import { needsFit, towFits } from '../seatFit';
import { defaultConfig, defaultPolicy, defaultStats, makeCar, makeDestinations, makeRequest, makeWeekDays, slotMs, WEEK_START_MS } from '../__fixtures__/gen';
import type { SolverInput } from '../types';

const HOME = 'home';
const WEEK = { startMs: WEEK_START_MS, days: makeWeekDays() };

function input(cars: SolverInput['cars'], requests: SolverInput['requests']): SolverInput {
  return {
    week: WEEK, homeLocationId: HOME, cars, requests, fixedRides: [],
    destinations: makeDestinations(), policy: defaultPolicy(), stats: defaultStats(), config: defaultConfig(),
  };
}

describe('REQ §13.200: a towing request needs a car with a hitch, one per ride', () => {
  it('towFits / needsFit: no hitch -> no; one towing request -> yes; two -> no', () => {
    const plain = makeCar('A', { luggageCapacity: 0 });
    const hitch = makeCar('B', { luggageCapacity: 0, towHitch: true });
    expect(towFits(plain, 0)).toBe(true);
    expect(towFits(plain, 1)).toBe(false);
    expect(towFits(hitch, 1)).toBe(true);
    expect(towFits(hitch, 2)).toBe(false);
    expect(needsFit(hitch, 1, 1)).toBe(false); // luggage still needs the large trunk
  });

  it('goes to the hitch car only', () => {
    const out = solve(input(
      [makeCar('A', { luggageCapacity: 0 }), makeCar('B', { luggageCapacity: 0, towHitch: true })],
      [makeRequest({ id: 'R1', towHitch: true, departureMs: slotMs(32), returnMs: slotMs(48) })],
    ));
    expect(out.assignments.map((a) => a.carId)).toEqual(['B']);
    expect(out.assignments[0]?.towCount).toBe(1);
  });

  it('with no hitch car it is unmet with UNMET_NEEDS_TOW_HITCH', () => {
    const out = solve(input(
      [makeCar('A', { luggageCapacity: 0 })],
      [makeRequest({ id: 'R1', towHitch: true, departureMs: slotMs(32), returnMs: slotMs(48) })],
    ));
    expect(out.assignments).toEqual([]);
    expect(out.unmet[0]?.reasonCode).toBe('UNMET_NEEDS_TOW_HITCH');
    expect(out.unmet[0]?.reason).toBe('צריך רכב גורר, ואין רכב גורר פנוי');
  });

  it('two overlapping towing requests never share the one hitch: one is unmet', () => {
    const out = solve(input(
      [makeCar('A', { luggageCapacity: 0 }), makeCar('B', { luggageCapacity: 0, towHitch: true })],
      [
        makeRequest({ id: 'R1', towHitch: true, departureMs: slotMs(32), returnMs: slotMs(48) }),
        makeRequest({ id: 'R2', towHitch: true, departureMs: slotMs(32), returnMs: slotMs(48) }),
      ],
    ));
    expect(out.assignments.every((a) => a.servedRequestIds.length === 1)).toBe(true);
    expect(out.assignments).toHaveLength(1);
    expect(out.unmet).toHaveLength(1);
    expect(['UNMET_TOW_HITCH_BUSY', 'UNMET_NO_CAR']).toContain(out.unmet[0]?.reasonCode);
  });

  it('non-overlapping towing requests share the hitch car over the day', () => {
    const out = solve(input(
      [makeCar('A', { luggageCapacity: 0 }), makeCar('B', { luggageCapacity: 0, towHitch: true })],
      [
        makeRequest({ id: 'R1', towHitch: true, departureMs: slotMs(8), returnMs: slotMs(16) }),
        makeRequest({ id: 'R2', towHitch: true, departureMs: slotMs(56), returnMs: slotMs(64) }),
      ],
    ));
    expect(out.unmet).toEqual([]);
    expect(new Set(out.assignments.map((a) => a.carId))).toEqual(new Set(['B']));
  });

  it('a request needing both large luggage and towing needs a car with both', () => {
    const out = solve(input(
      [makeCar('A', { luggageCapacity: 1 }), makeCar('B', { luggageCapacity: 0, towHitch: true }), makeCar('C', { luggageCapacity: 1, towHitch: true })],
      [makeRequest({ id: 'R1', luggage: true, towHitch: true, departureMs: slotMs(32), returnMs: slotMs(48) })],
    ));
    expect(out.assignments.map((a) => a.carId)).toEqual(['C']);
  });

  it('freed slot skips a towing request on a car without a hitch', () => {
    const car = makeCar('A', { luggageCapacity: 0 });
    const result = matchFreedSlot({
      car, timeline: new CarTimeline(car, 2, 96 * 7, HOME), freedWindow: { start: 32, end: 48 }, freedLocationId: HOME,
      candidates: [makeRequest({ id: 'R1', towHitch: true, departureMs: slotMs(32), returnMs: slotMs(48) })],
      destinations: makeDestinations(), policy: defaultPolicy(), stats: defaultStats(), config: defaultConfig(),
      week: WEEK, homeLocationId: HOME,
    });
    expect(result).toEqual([]);
  });
});
