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
    homeLocationId: HOME,
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

  it('REQUIREMENTS §13.95: detour over the limit refused, at the limit accepted (the ride starts earlier)', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(4)] })];
    const hosts = buildHostRides([hostAssignment()], new Map(cars.map((c) => [c.id, c])));
    // host home -> destA (30 min). Guest boards at a bus station and alights at destA.
    // home -> bus -> destA: explicit travel rows make the added driving exact.
    const run = (busToHome: number) => {
      const guest = guestNr({ originId: 'bus', destinationId: 'destA', departureMs: slotMs(30), returnMs: slotMs(48), flexDeparture: { earlierMin: 60, laterMin: 60 } });
      return findMergeHosts({
        guest, leg: 'out', hosts,
        ...commonParams(cars, { bus: { id: 'bus', zone: 'zoneA', distanceKm: 5, travelMinutes: 10 } }),
        travel: [
          { fromId: HOME, toId: 'bus', travelMinutes: busToHome, distanceKm: 5 },
          { fromId: 'bus', toId: 'destA', travelMinutes: 30, distanceKm: 20 },
        ],
      });
    };
    // 15 + 30 - 30 + 5 (stop dwell) = 20 added (= limit) -> accepted, window starts 2 slots earlier
    const ok = run(15);
    expect(ok).toHaveLength(1);
    expect(ok[0]?.addedOutMinutes).toBe(20);
    expect(ok[0]?.window.start).toBe(32 - 2);
    expect(ok[0]?.hostWindowBefore).toEqual({ start: 32, end: 48 });
    expect(ok[0]?.window.end).toBe(48);
    // 21 added -> refused
    expect(run(16)).toHaveLength(0);
  });

  it('REQUIREMENTS §13.95: a guest boarding at the host\'s final destination (Haifa -> Afula on a home -> Haifa host) is refused', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(4)] })];
    const hosts = buildHostRides([hostAssignment({ legs: [{ requestId: 'HOST', leg: 'out', carMode: 'relay', originId: HOME, destinationId: 'haifa', role: 'driver' }], destinationId: 'haifa' })], new Map(cars.map((c) => [c.id, c])));
    const guest = guestNr({ tripShape: 'one_way_to', originId: 'haifa', destinationId: 'afula', departureMs: slotMs(34) });
    const params = {
      ...commonParams(cars, { haifa: { id: 'haifa', zone: 'z', travelMinutes: 30 }, afula: { id: 'afula', zone: 'z', travelMinutes: 30 } }),
      travel: [{ fromId: 'haifa', toId: 'afula', travelMinutes: 5, distanceKm: 1 }],
    };
    expect(findMergeHosts({ guest, leg: 'out', hosts, ...params })).toHaveLength(0);
  });

  it('REQUIREMENTS §13.95: the return leg ends later by the added driving on the way back', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(4)] })];
    const hosts = buildHostRides([hostAssignment()], new Map(cars.map((c) => [c.id, c])));
    const guest = guestNr({ originId: 'bus', destinationId: 'destA', departureMs: slotMs(30), returnMs: slotMs(50), flexDeparture: { earlierMin: 60, laterMin: 60 }, flexReturn: { earlierMin: 60, laterMin: 60 } });
    const found = findMergeHosts({
      guest, leg: 'both', hosts,
      ...commonParams(cars, { bus: { id: 'bus', zone: 'zoneA', travelMinutes: 10 } }),
      travel: [{ fromId: HOME, toId: 'bus', travelMinutes: 15 }, { fromId: 'bus', toId: 'destA', travelMinutes: 30 }],
    });
    expect(found).toHaveLength(1);
    // out: home -> bus -> destA = 45 + 5 dwell vs 30: +20 = 2 slots earlier; return: +20 = 2 slots later
    expect(found[0]?.window).toEqual({ start: 30, end: 50 });
  });

  it('large luggage is a yes/no match: needs the large_trunk feature, no per-car count (REQ item 21)', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(4)], luggageCapacity: 0 })];
    const assignment = hostAssignment({ luggageCount: 1 });
    const hosts = buildHostRides([assignment], new Map(cars.map((c) => [c.id, c])));
    const guest = guestNr({ destinationId: 'destA', luggage: true });
    const noTrunk = findMergeHosts({ guest, leg: 'both', hosts, ...commonParams(cars) });
    expect(noTrunk).toHaveLength(0);

    const carsWithTrunk = [makeCar('C1', { seatConfigs: [passengers(4)], luggageCapacity: 1, features: ['large_trunk'] })];
    const hosts2 = buildHostRides([assignment], new Map(carsWithTrunk.map((c) => [c.id, c])));
    const withTrunk = findMergeHosts({ guest, leg: 'both', hosts: hosts2, ...commonParams(carsWithTrunk) });
    expect(withTrunk).toHaveLength(1);

    // a third luggage request still fits on the same large-trunk car
    const crowded = hostAssignment({ luggageCount: 2 });
    const hosts3 = buildHostRides([crowded], new Map(carsWithTrunk.map((c) => [c.id, c])));
    expect(findMergeHosts({ guest, leg: 'both', hosts: hosts3, ...commonParams(carsWithTrunk) })).toHaveLength(1);
  });

  it('a temporary car appears as a host ride but is never a merge target (REQ §13.99)', () => {
    const cars = [makeCar('C1', { type: 'temporary', seatConfigs: [passengers(4)] })];
    const assignment = hostAssignment({ source: 'fixed' });
    const hosts = buildHostRides([assignment], new Map(cars.map((c) => [c.id, c])));
    expect(hosts[0]?.isTemporary).toBe(true);
    const guest = guestNr({ destinationId: 'destA' });
    const candidates = findMergeHosts({ guest, leg: 'both', hosts, ...commonParams(cars) });
    expect(candidates).toHaveLength(0); // only the owner puts requests on a private car (REQ §13.99)
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

    // canDrive: false (REQUIREMENTS §13.88, rule made precise 2026-09-16): a
    // stored oneWayCarMode no longer forces passenger for a driver — only the
    // absence of an eligible driver on board does.
    const guest = guestNr({ tripShape: 'one_way_to', canDrive: false, destinationId: 'destA', departureMs: slotMs(32) });
    const candidates = findMergeHosts({ guest, leg: 'out', hosts, ...commonParams(cars) });
    const hostIds = candidates.map((c) => c.hostRideId);
    expect(hostIds).toContain('host-ride');
    expect(hostIds).toContain('relay-out');
    expect(hostIds).not.toContain('return-only');
  });

  it('REQUIREMENTS §13.95: a guest with another origin merges only if the detour fits (replaces the same-origin filter)', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(4)] })];
    // host-ride's driver leg originId is HOME (hostAssignment's default).
    const assignment = hostAssignment();
    const hosts = buildHostRides([assignment], new Map(cars.map((c) => [c.id, c])));

    const sameOriginGuest = guestNr({ destinationId: 'destA' }); // originId undefined -> HOME, like the host
    expect(findMergeHosts({ guest: sameOriginGuest, leg: 'both', hosts, ...commonParams(cars) })).toHaveLength(1);

    const otherOriginGuest = guestNr({ destinationId: 'destA', originId: 'HAIFA' });
    expect(findMergeHosts({ guest: otherOriginGuest, leg: 'both', hosts, ...commonParams(cars) })).toHaveLength(0);
  });
});

describe('auto-fill never merges into a temporary car (REQ §13.99)', () => {
  it('a request matching a private car\'s fixed ride stays unmet with no merge suggestion', async () => {
    const { solve } = await import('../index');
    const guest = makeRequest({ id: 'G', destinationId: 'destA', departureMs: slotMs(32), returnMs: slotMs(48) });
    const input = baseInput({
      cars: [makeCar('T1', { type: 'temporary', ownerMemberId: 'owner', seatConfigs: [passengers(4)] })],
      requests: [guest],
      fixedRides: [{
        id: 'fx', carId: 'T1', window: { start: 32, end: 48 }, originId: 'home', destinationId: 'home',
        driverMemberId: 'owner', legs: [], servedRequestIds: [], passengers: passengers(1), luggageCount: 0,
        overnightAck: false, kind: 'temporaryOwner',
      }],
    });
    const out = solve(input);
    expect(out.assignments.filter((a) => a.source === 'solver')).toEqual([]);
    expect(out.unmet.map((u) => u.requestId)).toEqual(['G']);
    expect(out.unmet.flatMap((u) => u.suggestions).some((s) => s.kind === 'merge' || s.kind === 'splitLegs')).toBe(false);
  });
});
