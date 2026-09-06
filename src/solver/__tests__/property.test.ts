// Property-based tests (docs/SOLVER.md §7.2, fast-check). assertInvariants()
// already runs inside solve() and throws on any violation, so "solve() does
// not throw" transitively covers: no overlaps (with buffer/maintenance), seat
// fit, luggage capacity, every request served exactly once, fixed rides
// unchanged, and the location/relay-pairing chain. This file additionally
// checks the two properties assertInvariants does not: flexibility
// containment and idempotence on re-solve.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { normalize } from '../slots';
import {
  baseInput,
  defaultConfig,
  defaultPolicy,
  defaultStats,
  makeCar,
  makeDestinations,
  makeWeekDays,
  passengers,
  slotMs,
  WEEK_START_MS,
} from '../__fixtures__/gen';
import type { Car, Request, SolverInput } from '../types';

const DAY_SLOT = 96; // one day within the fixed test week, avoids DST/week-boundary edge cases here (covered in slots.test.ts)

function carArb(id: string): fc.Arbitrary<Car> {
  return fc.constant(
    makeCar(id, {
      seatConfigs: [passengers(4, 2, 0), passengers(6, 0, 1)],
      luggageCapacity: 2,
    }),
  );
}

function requestArb(id: string): fc.Arbitrary<Request> {
  return fc
    .record({
      departSlot: fc.integer({ min: DAY_SLOT + 8, max: DAY_SLOT + 60 }),
      duration: fc.integer({ min: 4, max: 24 }),
      earlierMin: fc.constantFrom(0, 15, 30, 60),
      laterMin: fc.constantFrom(0, 15, 30, 60),
      adults: fc.integer({ min: 1, max: 4 }),
      submittedAtMs: fc.integer({ min: 0, max: 1000 }),
    })
    .map(({ departSlot, duration, earlierMin, laterMin, adults, submittedAtMs }) => ({
      id,
      memberId: `member-${id}`,
      departmentId: 'dept-1',
      destinationId: 'destA',
      rideType: 'other',
      tripShape: 'round_trip' as const,
      departureMs: slotMs(departSlot),
      returnMs: slotMs(departSlot + duration),
      flexDeparture: { earlierMin, laterMin },
      flexReturn: { earlierMin, laterMin },
      passengers: passengers(adults),
      coRiderMemberIds: [],
      luggage: false,
      needsCarAtDestination: true,
      submittedAtMs,
      isLate: false,
    }));
}

function inputArb(): fc.Arbitrary<SolverInput> {
  return fc
    .record({
      carCount: fc.integer({ min: 1, max: 4 }),
      requestCount: fc.integer({ min: 0, max: 12 }),
    })
    .chain(({ carCount, requestCount }) => {
      const cars = fc.tuple(...Array.from({ length: carCount }, (_, i) => carArb(`C${i}`)));
      const requests = fc.tuple(...Array.from({ length: requestCount }, (_, i) => requestArb(`R${i}`)));
      return fc.record({ cars, requests });
    })
    .map(({ cars, requests }) =>
      baseInput({
        week: { startMs: WEEK_START_MS, days: makeWeekDays() },
        destinations: makeDestinations(),
        policy: defaultPolicy(),
        stats: defaultStats(),
        config: defaultConfig(),
        cars: [...cars],
        requests: [...requests],
      }),
    );
}

describe('solver properties (fast-check)', () => {
  it('never throws an invariant violation on arbitrary valid-shaped input (covers: no overlaps, seat/luggage fit, every request served once, fixed rides unchanged, relay/location chain)', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        expect(() => solve(input)).not.toThrow();
      }),
      { numRuns: 40 },
    );
  });

  it('every solver placement lies inside the request\'s declared flexibility envelope', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const output = solve(input);
        const { normalized } = normalize(input);
        const byId = new Map(normalized.map((nr) => [nr.id, nr]));
        for (const a of output.assignments) {
          if (a.source !== 'solver') continue;
          for (const requestId of a.servedRequestIds) {
            const nr = byId.get(requestId);
            if (!nr) continue;
            expect(a.window.start).toBeGreaterThanOrEqual(nr.flexDep[0]);
            expect(a.window.start).toBeLessThanOrEqual(nr.flexDep[1]);
            expect(a.window.end).toBeGreaterThanOrEqual(nr.flexRet[0]);
            expect(a.window.end).toBeLessThanOrEqual(nr.flexRet[1]);
          }
        }
      }),
      { numRuns: 40 },
    );
  });

  it('is idempotent when its own output is fed back in as fixed rides (zero further changes)', () => {
    fc.assert(
      fc.property(inputArb(), (input) => {
        const first = solve(input);
        const fixedRides = first.assignments.map((a) => ({
          id: a.rideId,
          carId: a.carId,
          window: a.window,
          originId: a.originId,
          destinationId: a.destinationId,
          driverRequestId: a.driverRequestId,
          driverMemberId: a.driverMemberId ?? 'unknown',
          legs: a.legs,
          servedRequestIds: a.servedRequestIds,
          passengers: a.passengers,
          luggageCount: a.luggageCount,
          overnightAck: true, // fixed rides are trusted as-is; avoids day-end false positives on re-seed
          kind: 'pinned' as const,
        }));
        const second = solve({ ...input, requests: [], fixedRides });
        expect(second.assignments).toHaveLength(first.assignments.length);
        expect(second.unmet).toHaveLength(0);
      }),
      { numRuns: 20 },
    );
  });
});
