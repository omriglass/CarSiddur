import { describe, expect, it } from 'vitest';
import type { Unit, PlacedSingle } from '../greedy';
import { runImprove } from '../improve';
import { normalize } from '../slots';
import { buildTimelines } from '../timeline';
import { baseInput, defaultConfig, makeCar, makeRequest, slotMs, WEEK_START_MS, makeWeekDays } from '../__fixtures__/gen';
import type { SolverInput } from '../types';

function nrFor(id: string, departSlot: number, returnSlot: number, flex: { earlierMin?: number; laterMin?: number } = {}) {
  const input = baseInput({
    cars: [makeCar('C1')],
    requests: [
      makeRequest({
        id,
        departureMs: slotMs(departSlot),
        returnMs: slotMs(returnSlot),
        flexDeparture: { earlierMin: flex.earlierMin ?? 0, laterMin: flex.laterMin ?? 0 },
        flexReturn: { earlierMin: flex.earlierMin ?? 0, laterMin: flex.laterMin ?? 0 },
      }),
    ],
  });
  return normalize(input).normalized[0]!;
}

function unitFor(nr: ReturnType<typeof nrFor>, score: number): Unit {
  return { kind: 'single', id: nr.id, score, submittedAtMs: nr.request.submittedAtMs, single: nr };
}

const baseSolverInput: SolverInput = baseInput({ week: { startMs: WEEK_START_MS, days: makeWeekDays() } });

describe('runImprove', () => {
  it('depth-1: relocates a zero-flex blocker to a different, fully-free car, freeing the original for the unmet request', () => {
    const b = nrFor('B', 32, 48);
    const a = nrFor('A', 32, 48);
    const cars = [makeCar('C1'), makeCar('C2')];
    const timelines = buildTimelines(cars, 2, 96 * 7, 'home');
    timelines.get('C1')!.add({ rideId: `ride:${b.id}`, window: b.window, startLocationId: 'home', endLocationId: 'home', overnightAck: false });

    const placedSingles: PlacedSingle[] = [{ kind: 'single', nr: b, carId: 'C1', window: b.window, shift: { departureMin: 0, returnMin: 0 } }];
    const unmetUnits: Unit[] = [unitFor(a, 2)];
    const scores = new Map([
      ['A', { total: 2 }],
      ['B', { total: 1 }],
    ]);

    const input = { ...baseSolverInput, cars, config: defaultConfig() };
    const result = runImprove(unmetUnits, placedSingles, timelines, input, scores);

    expect(result.stillUnmetUnits).toHaveLength(0);
    expect(result.newlyPlaced).toHaveLength(1);
    expect(result.newlyPlaced[0]?.carId).toBe('C1');
    expect(result.relocationsApplied).toHaveLength(1);
    expect(result.relocationsApplied[0]?.toCarId).toBe('C2');
    expect(timelines.get('C2')!.has(`ride:${b.id}`)).toBe(true);
  });

  it('a fixed ride overlapping the envelope skips that car entirely (never relocated)', () => {
    const a = nrFor('A', 32, 48);
    const cars = [makeCar('C1')];
    const timelines = buildTimelines(cars, 2, 96 * 7, 'home');
    const input: SolverInput = {
      ...baseSolverInput,
      cars,
      config: defaultConfig(),
      fixedRides: [
        {
          id: 'fixed-1',
          carId: 'C1',
          window: { start: 32, end: 48 },
          originId: 'home',
          destinationId: 'home',
          driverMemberId: 'someone',
          legs: [],
          servedRequestIds: ['SOMEONE'],
          passengers: { adults: 1, childSeats: 0, boosters: 0 },
          luggageCount: 0,
          overnightAck: false,
          kind: 'pinned',
        },
      ],
    };
    const result = runImprove([unitFor(a, 5)], [], timelines, input, new Map([['A', { total: 5 }]]));
    expect(result.newlyPlaced).toHaveLength(0);
    expect(result.stillUnmetUnits).toHaveLength(1);
  });

  it('budget exhaustion stops further work and reports budgetExhausted, leaving prior results valid', () => {
    const b = nrFor('B', 32, 48);
    const a = nrFor('A', 32, 48);
    const cars = [makeCar('C1'), makeCar('C2')];
    const timelines = buildTimelines(cars, 2, 96 * 7, 'home');
    timelines.get('C1')!.add({ rideId: `ride:${b.id}`, window: b.window, startLocationId: 'home', endLocationId: 'home', overnightAck: false });
    const placedSingles: PlacedSingle[] = [{ kind: 'single', nr: b, carId: 'C1', window: b.window, shift: { departureMin: 0, returnMin: 0 } }];
    const input = { ...baseSolverInput, cars, config: defaultConfig({ improvementBudget: 0 }) };
    const result = runImprove([unitFor(a, 2)], placedSingles, timelines, input, new Map([['A', { total: 2 }]]));
    expect(result.budgetExhausted).toBe(true);
    expect(result.stillUnmetUnits).toHaveLength(1);
  });

  it('an ejection is offered as a suggestion (never applied) only when the unmet request outranks the sole immovable blocker', () => {
    const b = nrFor('B', 32, 48); // zero flex -> cannot relocate, cannot compress
    const a = nrFor('A', 32, 48); // also zero flex, so same-car compression can't help either
    const cars = [makeCar('C1')];
    const timelines = buildTimelines(cars, 2, 96 * 7, 'home');
    timelines.get('C1')!.add({ rideId: `ride:${b.id}`, window: b.window, startLocationId: 'home', endLocationId: 'home', overnightAck: false });
    const placedSingles: PlacedSingle[] = [{ kind: 'single', nr: b, carId: 'C1', window: b.window, shift: { departureMin: 0, returnMin: 0 } }];
    const input = { ...baseSolverInput, cars, config: defaultConfig() };

    // A outranks B: no relocation possible (zero flex everywhere) but ejecting B would let A fit -> suggestion, not applied.
    const higherScoreResult = runImprove([unitFor(a, 5)], placedSingles, timelines, input, new Map([['A', { total: 5 }], ['B', { total: 1 }]]));
    expect(higherScoreResult.newlyPlaced).toHaveLength(0); // never applied
    expect(higherScoreResult.stillUnmetUnits).toHaveLength(1);
    expect(higherScoreResult.ejectionSuggestions.has('A')).toBe(true);
    expect(higherScoreResult.ejectionSuggestions.get('A')?.kind).toBe('shiftWithinFlex');

    // A does NOT outrank B: no ejection suggestion at all (displacement is only ever for a higher-priority request).
    const timelines2 = buildTimelines(cars, 2, 96 * 7, 'home');
    timelines2.get('C1')!.add({ rideId: `ride:${b.id}`, window: b.window, startLocationId: 'home', endLocationId: 'home', overnightAck: false });
    const lowerScoreResult = runImprove([unitFor(a, 1)], placedSingles, timelines2, input, new Map([['A', { total: 1 }], ['B', { total: 5 }]]));
    expect(lowerScoreResult.ejectionSuggestions.has('A')).toBe(false);
  });
});
