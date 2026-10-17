// src/solver/__tests__/seriesRepair.test.ts
//
// REQUIREMENTS item 136 (e), docs/SOLVER.md §3.16: a multi-day series is placed early, repaired by moving the
// short rides that block a car (inside their own flexibility), and explained by a nearest-start suggestion
// when it still finds no car.

import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { assertInvariants } from '../invariants';
import type { FixedRide, Request, SolverInput } from '../types';
import { baseInput, flex, makeCar, makeRequest, makeSeriesLegs, passengers, slotMs } from '../__fixtures__/gen';

const DAY = 96;
const THU = 3;

function thursdaySeries(id = 'S'): Request[] {
  return makeSeriesLegs({ seriesId: id, seriesCount: 3, dayIndices: [THU, THU + 1, THU + 2] });
}

/** A short round trip on Thursday 08:00-10:00 with a boost that makes it outrank the series clearly. */
function thursdayRide(overrides: Partial<Request> = {}): Request {
  return makeRequest({
    id: 'SHORT',
    memberId: 'member-short',
    destinationId: 'destB',
    departureMs: slotMs(THU * DAY + 32),
    returnMs: slotMs(THU * DAY + 40),
    manualBoost: { value: 1, reason: 'test' },
    preferredCarId: 'C1',
    ...overrides,
  });
}

function fixed(id: string, carId: string, start: number, end: number): FixedRide {
  return {
    id,
    carId,
    window: { start, end },
    originId: 'home',
    destinationId: 'home',
    driverMemberId: 'someone',
    legs: [],
    servedRequestIds: [],
    passengers: passengers(1),
    luggageCount: 0,
    overnightAck: false,
    kind: 'pinned',
  };
}

function check(input: SolverInput) {
  const output = solve(input);
  assertInvariants(input, output);
  expect(solve(input)).toEqual(output);
  return output;
}

describe('series repair (item 136 e)', () => {
  it('moves a short blocker to another car inside its flexibility and places the series', () => {
    const legs = thursdaySeries();
    const input = baseInput({
      cars: [makeCar('C1'), makeCar('C2')],
      requests: [...legs, thursdayRide({ flexDeparture: flex(0, 240), flexReturn: flex(0, 240) })],
      // C2 is busy on Friday, so the series cannot go there and C1 is the only candidate
      fixedRides: [fixed('F', 'C2', (THU + 1) * DAY + 40, (THU + 1) * DAY + 60)],
    });
    const output = check(input);

    expect(output.unmet).toEqual([]);
    for (const leg of legs) {
      expect(output.assignments.find((a) => a.rideId === `ride:${leg.id}`)?.carId).toBe('C1');
    }
    const short = output.assignments.find((a) => a.rideId === 'ride:SHORT');
    expect(short?.carId).toBe('C2');
    expect(short?.shift).toEqual({ departureMin: 0, returnMin: 0 });
    expect(output.stats.relocations).toBe(1);
  });

  it('does not move a blocker outside its flexibility: the series stays unmet with a nearest-start suggestion', () => {
    const legs = thursdaySeries();
    const input = baseInput({
      cars: [makeCar('C1'), makeCar('C2')],
      requests: [...legs, thursdayRide()],
      // C2 is not free for the short ride at its own time, and not free for the series before 11:30
      fixedRides: [fixed('F', 'C2', THU * DAY + 28, THU * DAY + 44)],
    });
    const output = check(input);

    expect(output.assignments.find((a) => a.rideId === 'ride:SHORT')?.carId).toBe('C1');
    expect(output.stats.relocations).toBe(0);
    const head = output.unmet.find((u) => u.requestId === 'S-leg1');
    expect(head?.reasonCode).toBe('UNMET_SERIES_NO_CAR');
    // C1 is free again after the short ride (ends 10:00) plus the 30-minute turnaround: 10:30 on Thursday.
    expect(head?.suggestions).toHaveLength(1);
    const s = head?.suggestions[0];
    expect(s?.kind).toBe('shiftBeyondFlex');
    if (s?.kind !== 'shiftBeyondFlex') throw new Error('unreachable');
    expect(s.carId).toBe('C1');
    expect(s.window.start).toBe(THU * DAY + 42);
    expect(s.shift).toEqual({ departureMin: 10 * 15, returnMin: 0 });
    expect(s.reason).toContain('10:30');
    // only the head leg carries it
    expect(output.unmet.filter((u) => u.requestId !== 'S-leg1').every((u) => u.suggestions.length === 0)).toBe(true);
  });

  it('never moves a fixed ride', () => {
    const legs = thursdaySeries();
    const input = baseInput({
      cars: [makeCar('C1'), makeCar('C2')],
      requests: legs,
      fixedRides: [fixed('F1', 'C1', THU * DAY + 32, THU * DAY + 40), fixed('F2', 'C2', (THU + 1) * DAY + 40, (THU + 1) * DAY + 60)],
    });
    const output = check(input);

    expect(output.stats.relocations).toBe(0);
    expect(output.assignments.find((a) => a.rideId === 'F1')?.window).toEqual({ start: THU * DAY + 32, end: THU * DAY + 40 });
    expect(output.assignments.find((a) => a.rideId === 'F2')?.carId).toBe('C2');
    expect(output.unmet.map((u) => u.requestId)).toEqual(['S-leg1', 'S-leg2', 'S-leg3']);
  });

  it('places a series before a slightly higher-priority single, but yields to a clearly higher one', () => {
    const legs = thursdaySeries();
    const middleDay = (extra: Partial<Request>) =>
      makeRequest({
        id: 'MID',
        memberId: 'member-mid',
        destinationId: 'destB',
        departureMs: slotMs((THU + 1) * DAY + 32),
        returnMs: slotMs((THU + 1) * DAY + 48),
        ...extra,
      });

    const slight = check(baseInput({ cars: [makeCar('C1')], requests: [...legs, middleDay({ rideType: 'work' })] }));
    expect(slight.assignments.some((a) => a.rideId === 'ride:S-leg1')).toBe(true);
    expect(slight.unmet.map((u) => u.requestId)).toEqual(['MID']);

    const clear = check(baseInput({ cars: [makeCar('C1')], requests: [...legs, middleDay({ manualBoost: { value: 1, reason: 'test' } })] }));
    expect(clear.assignments.some((a) => a.servedRequestIds.includes('MID'))).toBe(true);
    expect(clear.unmet.map((u) => u.requestId)).toEqual(['S-leg1', 'S-leg2', 'S-leg3']);
  });
});
