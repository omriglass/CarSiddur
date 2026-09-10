// src/solver/__tests__/series.test.ts
//
// Multi-day series (docs/SOLVER.md §3.x): one Request row per calendar day
// sharing seriesId/seriesIndex/seriesCount. All-or-nothing on one car,
// contiguous with no buffer between legs, never a shift/merge/split
// suggestion target, excluded from live-phase helpers.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { assertInvariants } from '../invariants';
import type { Assignment, Car, Request, SolverInput } from '../types';
import {
  baseInput,
  makeCar,
  makeRequest,
  makeSeriesLegs,
  makeWeekDays,
  passengers,
  slotMs,
} from '../__fixtures__/gen';

function seriesRideIds(legs: Request[]): string[] {
  return legs.map((r) => `ride:${r.id}`);
}

describe('multi-day series', () => {
  it('places all three legs of a 3-day series on the same car, contiguous, PLACED_SERIES', () => {
    const legs = makeSeriesLegs({ seriesId: 'S1', seriesCount: 3, dayIndices: [0, 1, 2] });
    const input = baseInput({ cars: [makeCar('C1')], requests: legs });

    const output = solve(input);

    expect(output.unmet).toHaveLength(0);
    const rideIds = seriesRideIds(legs);
    const assignments = rideIds.map((id) => output.assignments.find((a) => a.rideId === id));
    expect(assignments.every((a) => a !== undefined)).toBe(true);
    const sorted = [...(assignments as Assignment[])].sort((a, b) => a.window.start - b.window.start);
    for (const a of sorted) {
      expect(a.carId).toBe('C1');
      expect(a.reasonCode).toBe('PLACED_SERIES');
      expect(a.seriesId).toBe('S1');
    }
    // Contiguous: each leg's end is the next leg's start, no gap, no buffer.
    expect(sorted[0]?.window.end).toBe(sorted[1]?.window.start);
    expect(sorted[1]?.window.end).toBe(sorted[2]?.window.start);
    // Location chain: car parked at the destination between legs, home at the very start/end.
    expect(sorted[0]?.originId).toBe('home');
    expect(sorted[0]?.destinationId).toBe('destA');
    expect(sorted[1]?.originId).toBe('destA');
    expect(sorted[1]?.destinationId).toBe('destA');
    expect(sorted[2]?.originId).toBe('destA');
    expect(sorted[2]?.destinationId).toBe('home');
  });

  it('never places the series partially: a higher-priority single request on the middle day wins the only car and the whole series goes unmet', () => {
    const legs = makeSeriesLegs({ seriesId: 'S2', seriesCount: 3, dayIndices: [0, 1, 2] });
    const competing = makeRequest({
      id: 'COMPETING',
      destinationId: 'destB',
      departureMs: slotMs(96 + 32), // day 1, 08:00
      returnMs: slotMs(96 + 48), // day 1, 12:00
      manualBoost: { value: 1, reason: 'test' },
    });
    const input = baseInput({ cars: [makeCar('C1')], requests: [...legs, competing] });

    const output = solve(input);

    // The competing request outranks the series (manual boost) and is served.
    expect(output.assignments.some((a) => a.servedRequestIds.includes('COMPETING'))).toBe(true);
    // The series is never split: none of its legs are assigned, all three are unmet.
    const rideIds = seriesRideIds(legs);
    expect(output.assignments.some((a) => rideIds.includes(a.rideId))).toBe(false);
    for (const leg of legs) {
      const u = output.unmet.find((x) => x.requestId === leg.id);
      expect(u).toBeDefined();
      expect(u?.reasonCode).toBe('UNMET_SERIES_NO_CAR');
      expect(u?.suggestions).toEqual([]);
    }
  });

  it('lands on the free car when the other car is busy on a middle day', () => {
    const legs = makeSeriesLegs({ seriesId: 'S3', seriesCount: 3, dayIndices: [0, 1, 2] });
    const fixedRideBlockingC1Day1: SolverInput['fixedRides'][number] = {
      id: 'fixed-1',
      carId: 'C1',
      window: { start: 96, end: 192 }, // all of day 1
      originId: 'home',
      destinationId: 'home',
      driverMemberId: 'other-member',
      legs: [],
      servedRequestIds: [],
      passengers: passengers(1),
      luggageCount: 0,
      overnightAck: false,
      kind: 'pinned',
    };
    const input = baseInput({
      cars: [makeCar('C1'), makeCar('C2')],
      requests: legs,
      fixedRides: [fixedRideBlockingC1Day1],
    });

    const output = solve(input);

    expect(output.unmet).toHaveLength(0);
    const rideIds = seriesRideIds(legs);
    for (const rideId of rideIds) {
      const a = output.assignments.find((x) => x.rideId === rideId);
      expect(a?.carId).toBe('C2');
    }
  });

  it('every leg becomes UNMET_SERIES_NO_CAR when no car can hold the whole series', () => {
    const legs = makeSeriesLegs({ seriesId: 'S4', seriesCount: 3, dayIndices: [0, 1, 2] });
    const tinyCar: Car = makeCar('C1', { seatConfigs: [passengers(0, 0, 0)] }); // fits nobody
    const input = baseInput({ cars: [tinyCar], requests: legs });

    const output = solve(input);

    expect(output.assignments).toHaveLength(0);
    expect(output.unmet).toHaveLength(3);
    for (const u of output.unmet) {
      expect(u.reasonCode).toBe('UNMET_SERIES_NO_CAR');
      expect(u.suggestions).toEqual([]);
    }
  });

  it('a continuation (first in-week leg starts Sunday 00:00) uses the car\'s startLocationId, not home', () => {
    // Global series of 4 legs; only the last two fall in this week (a continuation).
    const legs = makeSeriesLegs({ seriesId: 'S5', seriesCount: 4, dayIndices: [0, 1], globalFirstIndex: 3 });
    const car = makeCar('C1', { startLocationId: 'destA' });
    const input = baseInput({ cars: [car], requests: legs });

    const output = solve(input);

    expect(output.unmet).toHaveLength(0);
    const rideIds = seriesRideIds(legs);
    const sorted = rideIds
      .map((id) => output.assignments.find((a) => a.rideId === id))
      .filter((a): a is Assignment => a !== undefined)
      .sort((a, b) => a.window.start - b.window.start);
    expect(sorted[0]?.originId).toBe('destA'); // car already away, not home
    expect(sorted[0]?.window.start).toBe(0); // day 0, slot 0 (00:00)
    expect(sorted[1]?.destinationId).toBe('home'); // this week's leg is the true global last leg
  });

  it('invariants hold for a solved series (assertInvariants does not throw)', () => {
    const legs = makeSeriesLegs({ seriesId: 'S6', seriesCount: 3, dayIndices: [0, 1, 2] });
    const input = baseInput({ cars: [makeCar('C1')], requests: legs });
    const output = solve(input);
    expect(() => assertInvariants(input, output)).not.toThrow();
  });

  it('property: a random multi-day series is never split across cars — always all placed on one car, or entirely unmet', () => {
    const days = makeWeekDays();
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }), // leg count
        fc.integer({ min: 0, max: 3 }), // starting day (leaves room for up to 4 consecutive days)
        fc.integer({ min: 1, max: 3 }), // number of shared cars
        fc.integer({ min: 8, max: 88 }), // departure slot-of-day for the first leg
        fc.integer({ min: 8, max: 88 }), // return slot-of-day for the last leg
        (legCount, startDay, carCount, depSlot, retSlot) => {
          const dayIndices = Array.from({ length: legCount }, (_, i) => startDay + i);
          if (dayIndices[dayIndices.length - 1]! >= days.length) return true; // out of week, skip
          const legs = makeSeriesLegs({
            seriesId: 'PS',
            seriesCount: legCount,
            dayIndices,
            departureSlotOfDay: depSlot,
            returnSlotOfDay: retSlot,
          });
          const cars = Array.from({ length: carCount }, (_, i) => makeCar(`PC${i}`));
          const input = baseInput({ cars, requests: legs });

          const output = solve(input);
          const rideIds = seriesRideIds(legs);
          const placedCarIds = new Set(
            output.assignments.filter((a) => rideIds.includes(a.rideId)).map((a) => a.carId),
          );
          const placedCount = output.assignments.filter((a) => rideIds.includes(a.rideId)).length;

          // Never partial: either every leg placed (on exactly one car), or none placed.
          expect(placedCount === 0 || placedCount === legCount).toBe(true);
          expect(placedCarIds.size <= 1).toBe(true);
          return true;
        },
      ),
      { numRuns: 50, seed: 42 },
    );
  });
});
