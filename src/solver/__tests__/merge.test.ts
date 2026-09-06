import { describe, expect, it } from 'vitest';
import { buildHostRides, findMergeHosts } from '../merge';
import { normalize } from '../slots';
import { buildTimelines } from '../timeline';
import { baseInput, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';
import type { Assignment, Car, Destination } from '../types';

const HOME = 'home';

function hostAssignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    rideId: 'host-ride',
    carId: 'C1',
    window: { start: 32, end: 48 },
    originId: HOME,
    destinationId: HOME,
    driverRequestId: 'HOST',
    driverMemberId: 'host-member',
    legs: [{ requestId: 'HOST', leg: 'both', carMode: 'keep', originId: HOME, destinationId: 'destA', role: 'driver' }],
    servedRequestIds: ['HOST'],
    passengers: passengers(1),
    luggageCount: 0,
    shift: { departureMin: 0, returnMin: 0 },
    source: 'solver',
    reasonCode: 'PLACED_PREFERRED',
    reason: 'x',
    ...overrides,
  };
}

function guestNr(overrides: Parameters<typeof makeRequest>[0] = {}) {
  const input = baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ id: 'GUEST', departureMs: slotMs(32), returnMs: slotMs(48), ...overrides })] });
  return normalize(input).normalized[0]!;
}

function commonParams(cars: Car[], destinations: Record<string, Destination> = {}) {
  const timelines = buildTimelines(cars, 2, 96 * 7, HOME);
  return {
    destinations: { destA: { id: 'destA', zone: 'zoneA', distanceKm: 20, travelMinutes: 30 }, ...destinations },
    config: { bufferMinutes: 30, detour: { maxMinutes: 20, maxKm: 15 }, beyondFlexMaxMinutes: 120, defaultTravelMinutes: 60, chauffeurDwellMinutes: 10, improvementBudget: 5000, perRequestBudget: 200, externalHints: { cabMaxMinutes: 90, rentalMinHours: 30, ptMinScore: 0.6 } },
    cars: new Map(cars.map((c) => [c.id, c])),
    hostDriverRequests: new Map(),
    hostTimelines: timelines,
  };
}

describe('findMergeHosts', () => {
  it('same destination passes with zero detour', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(4)] })];
    const assignment = hostAssignment();
    const hosts = buildHostRides([assignment], new Map(cars.map((c) => [c.id, c])));
    const guest = guestNr({ destinationId: 'destA' });
    const candidates = findMergeHosts({ guest, leg: 'both', hosts, ...commonParams(cars) });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.detourMinutes).toBe(0);
  });

  it('detour just over the limit (21 min) fails; just at the limit (20 min) passes', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(4)] })];
    const assignment = hostAssignment();
    const hosts = buildHostRides([assignment], new Map(cars.map((c) => [c.id, c])));

    // detourMinutes = |travelDiff| + a 10-min cross-zone penalty (merge.ts ZONE_PENALTY_MINUTES);
    // distanceKm must also stay within maxKm (15) — match the host's 20km exactly so only the time check is exercised.
    const failing = guestNr({ destinationId: 'destFar' });
    const destinationsFail = { destFar: { id: 'destFar', zone: 'zoneOther', distanceKm: 20, travelMinutes: 30 + 11 } }; // 11+10=21 > 20
    const candidatesFail = findMergeHosts({ guest: failing, leg: 'both', hosts, ...commonParams(cars, destinationsFail) });
    expect(candidatesFail).toHaveLength(0);

    const passing = guestNr({ destinationId: 'destOk' });
    const destinationsPass = { destOk: { id: 'destOk', zone: 'zoneOther', distanceKm: 20, travelMinutes: 30 + 10 } }; // 10+10=20 == limit
    const candidatesPass = findMergeHosts({ guest: passing, leg: 'both', hosts, ...commonParams(cars, destinationsPass) });
    expect(candidatesPass).toHaveLength(1);
    expect(candidatesPass[0]?.detourMinutes).toBe(20);
  });

  it('luggage 2 needs the large_trunk feature (capacity 2)', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(4)], luggageCapacity: 1 })];
    const assignment = hostAssignment({ luggageCount: 1 });
    const hosts = buildHostRides([assignment], new Map(cars.map((c) => [c.id, c])));
    const guest = guestNr({ destinationId: 'destA', luggage: true });
    const noTrunk = findMergeHosts({ guest, leg: 'both', hosts, ...commonParams(cars) });
    expect(noTrunk).toHaveLength(0);

    const carsWithTrunk = [makeCar('C1', { seatConfigs: [passengers(4)], luggageCapacity: 2, features: ['large_trunk'] })];
    const hosts2 = buildHostRides([assignment], new Map(carsWithTrunk.map((c) => [c.id, c])));
    const withTrunk = findMergeHosts({ guest, leg: 'both', hosts: hosts2, ...commonParams(carsWithTrunk) });
    expect(withTrunk).toHaveLength(1);
  });

  it('a temporary car appears as a host but is never a target for solver placement (assignment-level guarantee tested in invariants)', () => {
    const cars = [makeCar('C1', { type: 'temporary', seatConfigs: [passengers(4)] })];
    const assignment = hostAssignment({ source: 'fixed' });
    const hosts = buildHostRides([assignment], new Map(cars.map((c) => [c.id, c])));
    expect(hosts[0]?.isTemporary).toBe(true);
    const guest = guestNr({ destinationId: 'destA' });
    const candidates = findMergeHosts({ guest, leg: 'both', hosts, ...commonParams(cars) });
    expect(candidates).toHaveLength(1); // temporary cars are valid merge hosts (REQ §6.4)
  });

  it('a fixed host never shifts even when the time is outside the guest flex', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(4)] })];
    const assignment = hostAssignment({ source: 'fixed', window: { start: 60, end: 70 } });
    const hosts = buildHostRides([assignment], new Map(cars.map((c) => [c.id, c])));
    const guest = guestNr({ destinationId: 'destA' }); // guest window [32,48), no flex -> host time incompatible
    const candidates = findMergeHosts({ guest, leg: 'both', hosts, ...commonParams(cars) });
    expect(candidates).toHaveLength(0);
  });

  it('a one-way passenger out-leg merges into a relay-out ride and into a keep ride\'s outbound, never into a return-only ride', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(4)] })];
    const keepHost = hostAssignment();
    const relayOutHost = hostAssignment({
      rideId: 'relay-out',
      window: { start: 32, end: 36 },
      destinationId: 'destA',
      legs: [{ requestId: 'HOST2', leg: 'out', carMode: 'relay', originId: HOME, destinationId: 'destA', role: 'driver' }],
      driverRequestId: 'HOST2',
      servedRequestIds: ['HOST2'],
    });
    const returnOnlyHost = hostAssignment({
      rideId: 'return-only',
      window: { start: 60, end: 64 },
      originId: 'destA',
      destinationId: HOME,
      legs: [{ requestId: 'HOST3', leg: 'return', carMode: 'relay', originId: 'destA', destinationId: HOME, role: 'driver' }],
      driverRequestId: 'HOST3',
      servedRequestIds: ['HOST3'],
    });
    const hosts = buildHostRides([keepHost, relayOutHost, returnOnlyHost], new Map(cars.map((c) => [c.id, c])));

    const guest = guestNr({ tripShape: 'one_way_to', oneWayCarMode: 'passenger', destinationId: 'destA', departureMs: slotMs(32) });
    const candidates = findMergeHosts({ guest, leg: 'out', hosts, ...commonParams(cars) });
    const hostIds = candidates.map((c) => c.hostRideId);
    expect(hostIds).toContain('host-ride');
    expect(hostIds).toContain('relay-out');
    expect(hostIds).not.toContain('return-only');
  });
});
