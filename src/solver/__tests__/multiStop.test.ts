// Multi-stop rides (REQUIREMENTS §13.93 "Multi-stop rides",
// docs/ORIGINS_PLAN_2026-10.md §6.2/§6.3, docs/SOLVER.md §1.3a / §3.8).
// Covers:
//  (a) legRoute()/legRouteMinutes()/legRouteSlots()/stopEtas()/routeEtaAt()
//      pure-helper cases, with/without stops, a free-text stop, return-leg
//      stops counted backwards;
//  (b) a one_way window grows by the route (not the plain origin<->destination
//      lookup) when the leg has stops;
//  (c) chauffeur windows with stops, for both candidates (drop-off and pickup);
//  (d) merge joining at an intermediate stop (findMergeHosts): a guest
//      boarding mid-route, outside flexibility, reversed order, and a
//      free-text stop never matching.

import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { buildHostRides, findMergeHosts } from '../merge';
import { normalize } from '../slots';
import { legRoute, legRouteMinutes, legRouteSlots, routeEtaAt, stopEtas } from '../travel';
import { baseInput, defaultConfig, makeCar, makeDestinations, makeRequest, passengers, slotMs } from '../__fixtures__/gen';
import type { Assignment, Destination, Request, TravelEdge } from '../types';

const HOME = 'home';

function lookup(overrides: { destinations?: Record<string, Destination>; travel?: TravelEdge[]; defaultTravelMinutes?: number } = {}) {
  return {
    travel: overrides.travel,
    homeLocationId: HOME,
    destinations: { ...makeDestinations(), ...overrides.destinations },
    config: { defaultTravelMinutes: overrides.defaultTravelMinutes ?? 60 },
  };
}

describe('legRoute() / legRouteMinutes() / legRouteSlots() (ORIGINS_PLAN §6.2)', () => {
  it('with no stops, the route is just [origin, destination] and minutes/slots match travelBetween exactly', () => {
    const request: Pick<Request, 'originId' | 'destinationId' | 'stops'> = { destinationId: 'destA' };
    const l = lookup();
    expect(legRoute(l, request, 'out')).toEqual([{ locationId: HOME }, { locationId: 'destA' }]);
    expect(legRouteMinutes(l, request, 'out', 5)).toBe(30); // destA.travelMinutes
    expect(legRouteSlots(l, request, 'out', 5)).toBe(2); // ceil(30/15)
  });

  it('with an out-stop, minutes = sum of hops + stopMinutes * stopCount', () => {
    const l = lookup({
      destinations: { BINYAMINA: { id: 'BINYAMINA', zone: 'zoneBinyamina', travelMinutes: 15, distanceKm: 10 } },
      travel: [{ fromId: 'BINYAMINA', toId: 'destA', travelMinutes: 30, distanceKm: 25 }],
    });
    const request: Pick<Request, 'originId' | 'destinationId' | 'stops'> = {
      destinationId: 'destA',
      stops: [{ leg: 'out', locationId: 'BINYAMINA' }],
    };
    expect(legRoute(l, request, 'out')).toEqual([{ locationId: HOME }, { locationId: 'BINYAMINA' }, { locationId: 'destA' }]);
    // hop(home,BINYAMINA)=15 + hop(BINYAMINA,destA)=30 + stopMinutes(5) = 50
    expect(legRouteMinutes(l, request, 'out', 5)).toBe(50);
    expect(legRouteSlots(l, request, 'out', 5)).toBe(4); // ceil(50/15)
  });

  it('a return-stop only applies to the return leg, not the out leg', () => {
    const l = lookup({
      destinations: { BINYAMINA: { id: 'BINYAMINA', zone: 'zoneBinyamina', travelMinutes: 15, distanceKm: 10 } },
    });
    const request: Pick<Request, 'originId' | 'destinationId' | 'stops'> = {
      destinationId: 'destA',
      stops: [{ leg: 'return', locationId: 'BINYAMINA' }],
    };
    expect(legRouteMinutes(l, request, 'out', 5)).toBe(30); // unaffected by the return-stop
    expect(legRoute(l, request, 'return')).toEqual([{ locationId: 'destA' }, { locationId: 'BINYAMINA' }, { locationId: HOME }]);
  });

  it('a free-text stop (no locationId) still adds a hop, always at defaultTravelMinutes on both sides', () => {
    const l = lookup({ defaultTravelMinutes: 60 });
    const request: Pick<Request, 'originId' | 'destinationId' | 'stops'> = {
      destinationId: 'destA',
      stops: [{ leg: 'out' }], // free text
    };
    expect(legRoute(l, request, 'out')).toEqual([{ locationId: HOME }, { locationId: undefined }, { locationId: 'destA' }]);
    // both hops touching the free-text stop use defaultTravelMinutes (60), not destA's own 30
    expect(legRouteMinutes(l, request, 'out', 5)).toBe(60 + 60 + 5);
  });
});

describe('stopEtas() / routeEtaAt() (ORIGINS_PLAN §6.2)', () => {
  const l = lookup({
    destinations: { BINYAMINA: { id: 'BINYAMINA', zone: 'zoneBinyamina', travelMinutes: 15, distanceKm: 10 } },
    travel: [{ fromId: 'BINYAMINA', toId: 'destA', travelMinutes: 30, distanceKm: 25 }],
  });
  const outRequest: Pick<Request, 'originId' | 'destinationId' | 'stops'> = {
    destinationId: 'destA',
    stops: [{ leg: 'out', locationId: 'BINYAMINA' }],
  };

  it('out ETAs count forward from the departure slot', () => {
    // hop(home,BINYAMINA) = 15 min = 1 slot
    expect(stopEtas(l, outRequest, 'out', 100, 5)).toEqual([{ locationId: 'BINYAMINA', slot: 101 }]);
  });

  it('routeEtaAt the origin/destination endpoints matches the anchor / total route', () => {
    expect(routeEtaAt(l, outRequest, 'out', 100, 5, HOME)).toBe(100); // departure itself
    // destination ETA = anchor + round(totalMinutes/15); totalMinutes = 15+30+5=50 -> round(50/15)=3
    expect(routeEtaAt(l, outRequest, 'out', 100, 5, 'destA')).toBe(103);
    expect(routeEtaAt(l, outRequest, 'out', 100, 5, 'BINYAMINA')).toBe(101);
  });

  it('return ETAs count backward from the arrival-at-origin slot', () => {
    const returnRequest: Pick<Request, 'originId' | 'destinationId' | 'stops'> = {
      destinationId: 'destA',
      stops: [{ leg: 'return', locationId: 'BINYAMINA' }],
    };
    // route(return) = [destA, BINYAMINA, home]; hop(BINYAMINA,home)=15min=1 slot
    expect(stopEtas(l, returnRequest, 'return', 200, 5)).toEqual([{ locationId: 'BINYAMINA', slot: 199 }]);
    expect(routeEtaAt(l, returnRequest, 'return', 200, 5, HOME)).toBe(200); // arrival itself
    // destination (departure of the return leg) = anchor - round(totalMinutes/15); total=30+15+5=50 -> round(50/15)=3
    expect(routeEtaAt(l, returnRequest, 'return', 200, 5, 'destA')).toBe(197);
  });

  it('an unknown or free-text location id has no ETA', () => {
    expect(routeEtaAt(l, outRequest, 'out', 100, 5, 'nowhere')).toBeUndefined();
    const freeTextRequest: Pick<Request, 'originId' | 'destinationId' | 'stops'> = { destinationId: 'destA', stops: [{ leg: 'out' }] };
    expect(routeEtaAt(l, freeTextRequest, 'out', 100, 5, 'anything')).toBeUndefined();
  });
});

describe('one_way relay window with stops (REQUIREMENTS §13.93)', () => {
  it('grows by the route, not the plain origin<->destination lookup', () => {
    const destinations = {
      ...makeDestinations(),
      STOP: { id: 'STOP', zone: 'zoneStop', travelMinutes: 15, distanceKm: 10 }, // home<->STOP
      destC: { id: 'destC', zone: 'zoneC', travelMinutes: 45, distanceKm: 30 }, // plain home<->destC (control)
    };
    const travel: TravelEdge[] = [{ fromId: 'STOP', toId: 'destC', travelMinutes: 30, distanceKm: 20 }];

    const withStops = baseInput({
      cars: [makeCar('C1')],
      destinations,
      travel,
      requests: [
        makeRequest({
          id: 'R1',
          tripType: 'one_way',
          tripShape: 'one_way_to',
          destinationId: 'destC',
          departureMs: slotMs(32),
          stops: [{ leg: 'out', locationId: 'STOP' }],
        }),
      ],
    });
    const output = solve(withStops);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    // route minutes = hop(home,STOP)=15 + hop(STOP,destC)=30 + stopMinutes(default 5) = 50 -> ceil(50/15) = 4 slots
    expect(ride?.window).toEqual({ start: 32, end: 36 });

    const withoutStops = baseInput({
      cars: [makeCar('C1')],
      destinations,
      travel,
      requests: [
        makeRequest({ id: 'R1', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'destC', departureMs: slotMs(32) }),
      ],
    });
    const controlRide = solve(withoutStops).assignments.find((a) => a.servedRequestIds.includes('R1'));
    // plain home<->destC lookup: 45 min -> ceil(45/15) = 3 slots (shorter — no stop overhead)
    expect(controlRide?.window).toEqual({ start: 32, end: 35 });
  });
});

describe('chauffeur windows with stops, both candidates (REQUIREMENTS §13.93, ORIGINS_PLAN §3/§6.2)', () => {
  const destinations = {
    ...makeDestinations(),
    STOP: { id: 'STOP', zone: 'zoneStop', travelMinutes: 15, distanceKm: 10 }, // home<->STOP
    destC: { id: 'destC', zone: 'zoneC', travelMinutes: 45, distanceKm: 30 }, // plain home<->destC
  };
  const travel: TravelEdge[] = [{ fromId: 'STOP', toId: 'destC', travelMinutes: 30, distanceKm: 20 }];
  // routeSlots (home -> STOP -> destC) = ceil((15+30+5)/15) = 4; directSlots (home<->destC, no stop) = ceil(45/15) = 3;
  // dwellSlots = round(10/15) = 1 (config default chauffeurDwellMinutes).

  function request(overrides: Partial<Request> = {}) {
    return makeRequest({
      id: 'R1',
      tripShape: 'one_way_to',
      destinationId: 'destC',
      departureMs: slotMs(40),
      stops: [{ leg: 'out', locationId: 'STOP' }],
      canDrive: true, // relay-eligible, but left unpaired so it heals into a chauffeur ride
      ...overrides,
    });
  }

  it('drop-off candidate (car at the origin): [D, D + ceil((route + direct + dwell) / 15))', () => {
    const input = baseInput({ cars: [makeCar('C1')], destinations, travel, requests: [request()] }); // car defaults to home
    const ride = solve(input).assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride?.reasonCode).toBe('PLACED_CHAUFFEUR_NO_RETURNER');
    expect(ride?.originId).toBe(HOME);
    expect(ride?.destinationId).toBe(HOME);
    // R8B13: rounded once from exact minutes: 50 + 45 + 10 = 105 min = 7 slots (not 4 + 3 + 1 = 8)
    expect(ride?.window).toEqual({ start: 40, end: 47 });
  });

  it('pickup candidate (car at the destination): ends at D + routeSlots, same total duration', () => {
    const input = baseInput({
      cars: [makeCar('C1', { startLocationId: 'destC' })], // not at home -> the drop-off candidate is unavailable
      destinations,
      travel,
      requests: [request()],
    });
    const ride = solve(input).assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride?.reasonCode).toBe('PLACED_CHAUFFEUR_NO_RETURNER');
    expect(ride?.originId).toBe('destC');
    expect(ride?.destinationId).toBe('destC');
    expect(ride?.window).toEqual({ start: 40 + 4 - 7, end: 40 + 4 }); // [37, 44)
  });
});

describe('merge joining at a stop (findMergeHosts, REQUIREMENTS §13.93, ORIGINS_PLAN §6.3)', () => {
  const HAIFA = 'HAIFA';
  const BINYAMINA = 'BINYAMINA';
  const destinations = {
    ...makeDestinations(),
    [HAIFA]: { id: HAIFA, zone: 'zoneHaifa' },
    [BINYAMINA]: { id: BINYAMINA, zone: 'zoneBinyamina', travelMinutes: 20, distanceKm: 15 }, // home<->BINYAMINA
  };
  const travel: TravelEdge[] = [{ fromId: HAIFA, toId: BINYAMINA, travelMinutes: 40, distanceKm: 35 }];
  const HOST_DEPARTURE = 40;
  // host route (out): HAIFA -> BINYAMINA -> home. ETA at BINYAMINA = 40 + round(40/15) = 40 + 3 = 43.
  const HOST_ETA_AT_BINYAMINA = 43;

  function hostNr(overrides: Partial<Request> = {}) {
    const input = baseInput({
      cars: [makeCar('CHOST')],
      destinations,
      travel,
      requests: [
        makeRequest({
          id: 'HOSTREQ',
          originId: HAIFA,
          destinationId: HOME,
          tripShape: 'one_way_to',
          departureMs: slotMs(HOST_DEPARTURE),
          stops: [{ leg: 'out', locationId: BINYAMINA }],
          canDrive: true,
          ...overrides,
        }),
      ],
    });
    return normalize(input).normalized[0]!;
  }

  function hostAssignment(): Assignment {
    return {
      rideId: 'host-ride',
      carId: 'CHOST',
      window: { start: HOST_DEPARTURE, end: HOST_DEPARTURE + 5 },
      originId: HAIFA,
      destinationId: HOME,
      driverRequestId: 'HOSTREQ',
      driverMemberId: 'host-member',
      legs: [{ requestId: 'HOSTREQ', leg: 'out', carMode: 'relay', originId: HAIFA, destinationId: HOME, role: 'driver' }],
      servedRequestIds: ['HOSTREQ'],
      passengers: passengers(1),
      luggageCount: 0,
      shift: { departureMin: 0, returnMin: 0 },
      source: 'solver',
      reasonCode: 'PLACED_PREFERRED',
      reason: 'x',
    };
  }

  function guestNrAt(overrides: Partial<Request>) {
    const input = baseInput({
      cars: [makeCar('CGUEST')],
      destinations,
      travel,
      requests: [makeRequest({ id: 'GUEST', tripShape: 'one_way_to', canDrive: false, ...overrides })],
    });
    return normalize(input).normalized[0]!;
  }

  function search(guest: ReturnType<typeof guestNrAt>, hostNrOverride?: ReturnType<typeof hostNr>) {
    const cars = [makeCar('CHOST', { seatConfigs: [passengers(4)] })];
    const assignment = hostAssignment();
    const hosts = buildHostRides([assignment], new Map(cars.map((c) => [c.id, c])));
    return findMergeHosts({
      guest,
      leg: 'out',
      hosts,
      destinations,
      config: defaultConfig(),
      cars: new Map(cars.map((c) => [c.id, c])),
      hostDriverRequests: new Map([['host-ride', hostNrOverride ?? hostNr()]]),
      hostTimelines: new Map(),
      homeLocationId: HOME,
      travel,
    });
  }

  it('a guest Binyamina -> home joins the Haifa -> Binyamina -> home host at the right time, boarding at Binyamina', () => {
    const guest = guestNrAt({ originId: BINYAMINA, destinationId: HOME, departureMs: slotMs(HOST_ETA_AT_BINYAMINA) });
    const candidates = search(guest);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ hostRideId: 'host-ride', boardAtLocationId: BINYAMINA, detourMinutes: 0 });
  });

  it('a guest outside their own declared flexibility does not join', () => {
    const guest = guestNrAt({ originId: BINYAMINA, destinationId: HOME, departureMs: slotMs(HOST_ETA_AT_BINYAMINA + 7) });
    expect(search(guest)).toHaveLength(0);
  });

  it('a reversed-order guest (home -> Binyamina on that host) does not join', () => {
    const guest = guestNrAt({ originId: HOME, destinationId: BINYAMINA, departureMs: slotMs(HOST_ETA_AT_BINYAMINA) });
    expect(search(guest)).toHaveLength(0);
  });

  it('a free-text stop never matches a guest trying to board there', () => {
    const guest = guestNrAt({ originId: BINYAMINA, destinationId: HOME, departureMs: slotMs(HOST_ETA_AT_BINYAMINA) });
    const freeTextHostNr = hostNr({ stops: [{ leg: 'out' }] }); // free-text out-stop instead of BINYAMINA
    expect(search(guest, freeTextHostNr)).toHaveLength(0);
  });
});
