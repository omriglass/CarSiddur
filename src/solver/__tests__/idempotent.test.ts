import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import type { FixedRide, SolverInput } from '../types';
import { baseInput, flex, makeCar, makeRequest, mulberry32, passengers, slotMs } from '../__fixtures__/gen';

// R4B1: one auto-fill click places everything it can — re-solving with the first
// result's own rides fixed (what applySolve does on the next click) adds nothing.
function randomInput(seed: number): SolverInput {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const cars = [makeCar('C1'), makeCar('C2', { seatConfigs: [passengers(6, 2, 0)] }), makeCar('C3')];
  const requests = Array.from({ length: 18 }, (_, i) => {
    const day = Math.floor(rnd() * 3) * 96;
    const dep = day + 28 + Math.floor(rnd() * 20);
    const kind = pick(['round', 'round', 'oneWay', 'dropOff']);
    const base = {
      id: `R${String(i).padStart(2, '0')}`,
      destinationId: pick(['destA', 'destB']),
      departureMs: slotMs(dep),
      flexDeparture: flex(pick([0, 30, 60]), pick([0, 30, 60])),
      passengers: passengers(1 + Math.floor(rnd() * 2), rnd() < 0.2 ? 1 : 0),
    };
    if (kind === 'oneWay') return makeRequest({ ...base, tripType: 'one_way', tripShape: 'one_way_to' });
    if (kind === 'dropOff')
      return makeRequest({ ...base, tripType: 'drop_off', tripShape: 'one_way_to', needsCarAtDestination: false });
    return makeRequest({ ...base, returnMs: slotMs(dep + 8 + Math.floor(rnd() * 20)), flexReturn: flex(30, 30) });
  });
  return baseInput({ cars, requests });
}

describe('solve is idempotent against its own result (R4B1)', () => {
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))('seed %i', (seed) => {
    const input = randomInput(seed);
    const first = solve(input);
    const fixedRides: FixedRide[] = first.assignments
      .filter((a) => a.source !== 'fixed')
      .map((a) => ({
        id: a.rideId,
        carId: a.carId,
        window: a.window,
        originId: a.originId,
        destinationId: a.destinationId,
        driverRequestId: a.driverRequestId,
        driverMemberId: a.driverMemberId,
        legs: a.legs,
        servedRequestIds: a.servedRequestIds,
        passengers: a.passengers,
        luggageCount: a.luggageCount,
        overnightAck: false,
        kind: 'pinned' as const,
      }));
    const served = new Set(fixedRides.flatMap((f) => f.servedRequestIds));
    const second = solve({
      ...input,
      fixedRides: [...input.fixedRides, ...fixedRides],
      requests: input.requests.filter((r) => !served.has(r.id)),
    });
    const added = second.assignments.filter((a) => a.source !== 'fixed').flatMap((a) => a.servedRequestIds);
    expect(added).toEqual([]);
  });
});
