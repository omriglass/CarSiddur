import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { matchFreedSlot } from '../live';
import { CarTimeline } from '../timeline';
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

describe('large luggage needs a large-trunk car', () => {
  it('goes to the big-trunk car only', () => {
    const out = solve(input(
      [makeCar('A', { luggageCapacity: 0 }), makeCar('B', { luggageCapacity: 1 })],
      [makeRequest({ id: 'R1', luggage: true, departureMs: slotMs(32), returnMs: slotMs(48) })],
    ));
    expect(out.assignments.map((a) => a.carId)).toEqual(['B']);
  });

  it('any number of luggage requests share the one large-trunk car (no count cap)', () => {
    const out = solve(input(
      [makeCar('A', { luggageCapacity: 0 }), makeCar('B', { luggageCapacity: 1 })],
      [
        makeRequest({ id: 'R1', luggage: true, departureMs: slotMs(8), returnMs: slotMs(16) }),
        makeRequest({ id: 'R2', luggage: true, departureMs: slotMs(32), returnMs: slotMs(40) }),
        makeRequest({ id: 'R3', luggage: true, departureMs: slotMs(56), returnMs: slotMs(64) }),
      ],
    ));
    expect(out.unmet).toEqual([]);
    expect(new Set(out.assignments.map((a) => a.carId))).toEqual(new Set(['B']));
  });

  it('with no big-trunk car it is unmet with UNMET_NEEDS_LARGE_TRUNK', () => {
    const out = solve(input(
      [makeCar('A', { luggageCapacity: 0 })],
      [makeRequest({ id: 'R1', luggage: true, departureMs: slotMs(32), returnMs: slotMs(48) })],
    ));
    expect(out.assignments).toEqual([]);
    expect(out.unmet[0]?.reasonCode).toBe('UNMET_NEEDS_LARGE_TRUNK');
    expect(out.unmet[0]?.reason).toBe('צריך רכב עם תא מטען גדול');
  });

  it('freed slot skips a luggage request on a car without a big trunk', () => {
    const car = makeCar('A', { luggageCapacity: 0 });
    const result = matchFreedSlot({
      car, timeline: new CarTimeline(car, 2, 96 * 7, HOME), freedWindow: { start: 32, end: 48 }, freedLocationId: HOME,
      candidates: [makeRequest({ id: 'R1', luggage: true, departureMs: slotMs(32), returnMs: slotMs(48) })],
      destinations: makeDestinations(), policy: defaultPolicy(), stats: defaultStats(), config: defaultConfig(),
      week: WEEK, homeLocationId: HOME,
    });
    expect(result).toEqual([]);
  });
});

describe('matchFreedSlot priorityRequestIds', () => {
  it('ranks priority candidates first, then existing order', () => {
    const car = makeCar('C1');
    const mk = () => ({
      car, timeline: new CarTimeline(car, 2, 96 * 7, HOME), freedWindow: { start: 32, end: 48 }, freedLocationId: HOME,
      candidates: [
        makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) }),
        makeRequest({ id: 'R2', departureMs: slotMs(32), returnMs: slotMs(48) }),
      ],
      destinations: makeDestinations(), policy: defaultPolicy(), stats: defaultStats(), config: defaultConfig(),
      week: WEEK, homeLocationId: HOME,
    });
    expect(matchFreedSlot(mk()).map((r) => r.requestId)).toEqual(['R1', 'R2']);
    expect(matchFreedSlot(mk(), { priorityRequestIds: ['R2'] }).map((r) => r.requestId)).toEqual(['R2', 'R1']);
  });
});
