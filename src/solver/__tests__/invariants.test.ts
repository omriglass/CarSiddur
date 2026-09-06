import { describe, expect, it } from 'vitest';
import { assertInvariants } from '../invariants';
import { baseInput, makeCar, makeRequest, passengers, slotMs, makeWeekDays, WEEK_START_MS } from '../__fixtures__/gen';
import type { Assignment, SolverOutput } from '../types';

function emptyStats(): SolverOutput['stats'] {
  return { served: 0, unmet: 0, needsDriver: 0, relocations: 0, budgetExhausted: false, elapsedMs: 0 };
}

function baseAssignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    rideId: 'ride:R1',
    carId: 'C1',
    window: { start: 32, end: 48 },
    originId: 'home',
    destinationId: 'home',
    driverRequestId: 'R1',
    driverMemberId: 'm1',
    legs: [{ requestId: 'R1', leg: 'both', carMode: 'keep', originId: 'home', destinationId: 'destA', role: 'driver' }],
    servedRequestIds: ['R1'],
    passengers: passengers(1),
    luggageCount: 0,
    shift: { departureMin: 0, returnMin: 0 },
    source: 'solver',
    reasonCode: 'PLACED_PREFERRED',
    reason: 'x',
    ...overrides,
  };
}

describe('assertInvariants', () => {
  it('passes for a valid, minimal output', () => {
    const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) })] });
    const output: SolverOutput = {
      policyId: 'p',
      policyVersion: 1,
      assignments: [baseAssignment()],
      unmet: [],
      mergeOpportunities: [],
      carsAway: [],
      warnings: [],
      stats: emptyStats(),
    };
    expect(() => assertInvariants(input, output)).not.toThrow();
  });

  it('throws when two rides overlap (within buffer) on the same car', () => {
    const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ id: 'R1' }), makeRequest({ id: 'R2' })] });
    const output: SolverOutput = {
      policyId: 'p',
      policyVersion: 1,
      assignments: [
        baseAssignment({ rideId: 'ride:R1', servedRequestIds: ['R1'], window: { start: 32, end: 48 } }),
        baseAssignment({ rideId: 'ride:R2', driverRequestId: 'R2', servedRequestIds: ['R2'], window: { start: 49, end: 60 } }),
      ],
      unmet: [],
      mergeOpportunities: [],
      carsAway: [],
      warnings: [],
      stats: emptyStats(),
    };
    expect(() => assertInvariants(input, output)).toThrow(/OVERLAP_OR_LOCATION|overlaps/);
  });

  it('throws on seat overflow', () => {
    const car = makeCar('C1', { seatConfigs: [passengers(2)] });
    const input = baseInput({ cars: [car], requests: [makeRequest({ id: 'R1' })] });
    const output: SolverOutput = {
      policyId: 'p',
      policyVersion: 1,
      assignments: [baseAssignment({ passengers: passengers(5) })],
      unmet: [],
      mergeOpportunities: [],
      carsAway: [],
      warnings: [],
      stats: emptyStats(),
    };
    expect(() => assertInvariants(input, output)).toThrow(/SEAT_OVERFLOW|seat/);
  });

  it('throws when a request is missing from both assignments and unmet', () => {
    const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ id: 'R1' }), makeRequest({ id: 'R2' })] });
    const output: SolverOutput = {
      policyId: 'p',
      policyVersion: 1,
      assignments: [baseAssignment()],
      unmet: [],
      mergeOpportunities: [],
      carsAway: [],
      warnings: [],
      stats: emptyStats(),
    };
    expect(() => assertInvariants(input, output)).toThrow(/MISSING_REQUEST|missing/);
  });

  it('throws when a fixed ride is reported changed', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [],
      fixedRides: [
        {
          id: 'fixed-1',
          carId: 'C1',
          window: { start: 32, end: 48 },
          originId: 'home',
          destinationId: 'home',
          driverRequestId: 'R1',
          driverMemberId: 'm1',
          legs: [],
          servedRequestIds: ['R1'],
          passengers: passengers(1),
          luggageCount: 0,
          overnightAck: false,
          kind: 'pinned',
        },
      ],
    });
    const output: SolverOutput = {
      policyId: 'p',
      policyVersion: 1,
      assignments: [baseAssignment({ rideId: 'fixed-1', source: 'fixed', window: { start: 40, end: 48 } })], // window changed!
      unmet: [],
      mergeOpportunities: [],
      carsAway: [],
      warnings: [],
      stats: emptyStats(),
    };
    expect(() => assertInvariants(input, output)).toThrowError(expect.objectContaining({ code: 'FIXED_RIDE_CHANGED' }));
  });

  it('throws when a temporary car is used away from home', () => {
    const car = makeCar('C1', { type: 'temporary' });
    const input = baseInput({ cars: [car], requests: [makeRequest({ id: 'R1' })] });
    const output: SolverOutput = {
      policyId: 'p',
      policyVersion: 1,
      assignments: [baseAssignment({ destinationId: 'destA' })],
      unmet: [],
      mergeOpportunities: [],
      carsAway: [],
      warnings: [],
      stats: emptyStats(),
    };
    expect(() => assertInvariants(input, output)).toThrowError(expect.objectContaining({ code: 'TEMP_CAR_AWAY' }));
  });

  it('throws when a shared car is away at day end without an acknowledged overnight ride', () => {
    const days = makeWeekDays();
    const input = baseInput({ week: { startMs: WEEK_START_MS, days }, cars: [makeCar('C1')], requests: [] });
    const output: SolverOutput = {
      policyId: 'p',
      policyVersion: 1,
      assignments: [
        baseAssignment({
          rideId: 'ride:relay-out',
          servedRequestIds: ['R1'],
          window: { start: 32, end: 36 },
          originId: 'home',
          destinationId: 'destA',
          legs: [{ requestId: 'R1', leg: 'out', carMode: 'relay', originId: 'home', destinationId: 'destA', role: 'driver' }],
        }),
      ],
      unmet: [],
      mergeOpportunities: [],
      carsAway: [],
      warnings: [],
      stats: emptyStats(),
    };
    expect(() => assertInvariants(input, output)).toThrowError(expect.objectContaining({ code: 'CAR_AWAY_AT_DAY_END' }));
  });

  it('does not throw when the away-at-day-end block came from a fixed ride (soft, caller/SQL responsibility)', () => {
    const days = makeWeekDays();
    const input = baseInput({
      week: { startMs: WEEK_START_MS, days },
      cars: [makeCar('C1')],
      requests: [],
      fixedRides: [
        {
          id: 'fixed-relay',
          carId: 'C1',
          window: { start: 32, end: 36 },
          originId: 'home',
          destinationId: 'destA',
          driverRequestId: 'R1',
          driverMemberId: 'm1',
          legs: [{ requestId: 'R1', leg: 'out', carMode: 'relay', originId: 'home', destinationId: 'destA', role: 'driver' }],
          servedRequestIds: ['R1'],
          passengers: passengers(1),
          luggageCount: 0,
          overnightAck: false,
          kind: 'pinned',
        },
      ],
    });
    const output: SolverOutput = {
      policyId: 'p',
      policyVersion: 1,
      assignments: [
        baseAssignment({
          rideId: 'fixed-relay',
          source: 'fixed',
          servedRequestIds: ['R1'],
          window: { start: 32, end: 36 },
          originId: 'home',
          destinationId: 'destA',
          legs: [{ requestId: 'R1', leg: 'out', carMode: 'relay', originId: 'home', destinationId: 'destA', role: 'driver' }],
        }),
      ],
      unmet: [],
      mergeOpportunities: [],
      carsAway: [],
      warnings: [],
      stats: emptyStats(),
    };
    expect(() => assertInvariants(input, output)).not.toThrow();
  });
});
