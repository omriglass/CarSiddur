import { describe, expect, it } from 'vitest';
import { trySplitLegs, type SplitLegsContext } from '../splitLegs';
import { normalize } from '../slots';
import { buildTimelines } from '../timeline';
import { baseInput, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';
import type { Assignment, Destination } from '../types';

const HOME = 'home';
const DESTA: Destination = { id: 'destA', zone: 'zoneA', distanceKm: 20, travelMinutes: 30 };

function hostRide(
  id: string,
  driverRequestId: string,
  window: { start: number; end: number },
  leg: 'both' | 'out' | 'return',
  originId = HOME,
  destinationId = HOME,
  carId = 'HOSTCAR',
): Assignment {
  return {
    rideId: id,
    carId,
    window,
    originId,
    destinationId,
    driverRequestId,
    driverMemberId: `member-${driverRequestId}`,
    legs: [{ requestId: driverRequestId, leg, carMode: leg === 'both' ? 'keep' : 'relay', originId, destinationId: leg === 'return' ? HOME : 'destA', role: 'driver' }],
    servedRequestIds: [driverRequestId],
    passengers: passengers(1),
    luggageCount: 0,
    shift: { departureMin: 0, returnMin: 0 },
    source: 'solver',
    reasonCode: 'PLACED_PREFERRED',
    reason: 'x',
  };
}

function makeCtx(assignments: Assignment[], cars = [makeCar('C1'), makeCar('HOSTCAR')]): SplitLegsContext {
  const timelines = buildTimelines(cars, 2, 96 * 7, HOME);
  for (const a of assignments) {
    timelines.get(a.carId)?.add({ rideId: a.rideId, window: a.window, startLocationId: a.originId, endLocationId: a.destinationId, overnightAck: false });
  }
  return {
    destinations: { destA: DESTA, home: { id: 'home', zone: 'home' } },
    config: { bufferMinutes: 30, detour: { maxMinutes: 20, maxKm: 15 }, beyondFlexMaxMinutes: 120, defaultTravelMinutes: 60, chauffeurDwellMinutes: 10, improvementBudget: 5000, perRequestBudget: 200, externalHints: { cabMaxMinutes: 90, rentalMinHours: 30, ptMinScore: 0.6 } },
    cars: new Map(cars.map((c) => [c.id, c])),
    assignments,
    hostDriverRequests: new Map(),
    timelines,
    unpairedRelay: [],
    home: HOME,
  };
}

function guestNr(overrides: Parameters<typeof makeRequest>[0] = {}) {
  const input = baseInput({
    cars: [makeCar('C1')],
    requests: [
      makeRequest({
        id: 'GUEST',
        destinationId: 'destA',
        needsCarAtDestination: false,
        departureMs: slotMs(32),
        returnMs: slotMs(48),
        ...overrides,
      }),
    ],
  });
  return normalize(input).normalized[0]!;
}

describe('trySplitLegs', () => {
  it('finds two distinct hosts X (out) and Y (return)', () => {
    // X's departure matches the guest's out-leg time exactly; Y's return matches the guest's return-leg time exactly.
    const x = hostRide('X', 'HOSTX', { start: 32, end: 50 }, 'both', HOME, HOME, 'CARX');
    const y = hostRide('Y', 'HOSTY', { start: 30, end: 48 }, 'both', HOME, HOME, 'CARY');
    const nr = guestNr();
    const cars = [makeCar('CARX'), makeCar('CARY')];
    const result = trySplitLegs(nr, makeCtx([x, y], cars));
    expect(result).not.toBeNull();
    expect(result?.outbound.carMode).toBe('passenger');
    expect(result?.return.carMode).toBe('passenger');
    expect(result?.outbound.hostRideId).not.toBe(result?.return.hostRideId);
  });

  it('returns null (no split, no self-pair car available) when only one host could serve both legs (collapses to a plain merge, reported by the caller)', () => {
    const only = hostRide('ONLY', 'HOSTONLY', { start: 32, end: 48 }, 'both', HOME, HOME, 'HOSTCAR');
    const nr = guestNr();
    const result = trySplitLegs(nr, makeCtx([only], [makeCar('HOSTCAR')]));
    expect(result).toBeNull();
  });

  it('is a no-op for round trips with needsCarAtDestination = true', () => {
    const nr = guestNr({ needsCarAtDestination: true });
    expect(trySplitLegs(nr, makeCtx([]))).toBeNull();
  });

  it('relay/relay self-pair: the car is free at the destination in between for a third request', () => {
    const nr = guestNr();
    const ctx = makeCtx([], [makeCar('SELFCAR', { seatConfigs: [passengers(4)] })]);
    const result = trySplitLegs(nr, ctx);
    expect(result).not.toBeNull();
    expect(result?.outbound.carMode).toBe('relay');
    expect(result?.return.carMode).toBe('relay');
    expect(result?.outbound.carId).toBe(result?.return.carId);
  });
});
