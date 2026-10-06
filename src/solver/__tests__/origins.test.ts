// Origins, three trip types, cars stay where they are left (REQUIREMENTS
// §13.93, docs/ORIGINS_PLAN_2026-10.md §4 — solver step O4). Covers:
//  (a) effectiveTripType()/originIdOf()/travelBetween() pure helpers;
//  (b) an explicit `one_way` trip type places as a single relay leg with no
//      pairing obligation and no chauffeur fallback, governed only by
//      CarTimeline's end-check;
//  (c) the end-check rejects a one-way placement that would strand an
//      already-seeded fixed ride expecting the car back where it started;
//  (d) `drop_off` (legacy one-way derivation) wraps the request's own origin,
//      not necessarily the department home, when healed into a chauffeur ride;
//  (e) a free-text origin is never placed;
//  (f) the `changeOrigin` suggestion fires when a car is free for the whole
//      window at another place it already is;
//  (g) a car's location persists across days/weeks regardless of origin.

import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { effectiveTripType, originIdOf, travelBetween } from '../travel';
import { baseInput, makeCar, makeDestinations, makeRequest, slotMs } from '../__fixtures__/gen';
import type { Request } from '../types';

const HOME = 'home';

function baseRequest(overrides: Partial<Request> = {}): Pick<Request, 'tripType' | 'tripShape' | 'needsCarAtDestination'> {
  return { tripShape: 'round_trip', needsCarAtDestination: true, ...overrides };
}

describe('effectiveTripType() (REQUIREMENTS §13.93)', () => {
  it('an explicit tripType always wins', () => {
    expect(effectiveTripType(baseRequest({ tripType: 'one_way', tripShape: 'one_way_to' }))).toBe('one_way');
    expect(effectiveTripType(baseRequest({ tripType: 'drop_off' }))).toBe('drop_off');
  });
  it('round_trip + needsCarAtDestination=true -> round_trip', () => {
    expect(effectiveTripType(baseRequest())).toBe('round_trip');
  });
  it('round_trip + needsCarAtDestination=false -> drop_off', () => {
    expect(effectiveTripType(baseRequest({ needsCarAtDestination: false }))).toBe('drop_off');
  });
  it('any legacy one-way shape with no explicit tripType -> drop_off (never the new one_way)', () => {
    expect(effectiveTripType(baseRequest({ tripShape: 'one_way_to' }))).toBe('drop_off');
    expect(effectiveTripType(baseRequest({ tripShape: 'one_way_from' }))).toBe('drop_off');
  });
});

describe('originIdOf() (REQUIREMENTS §13.93)', () => {
  it('undefined originId falls back to the department home', () => {
    expect(originIdOf({ originId: undefined }, HOME)).toBe(HOME);
  });
  it('an explicit originId is used as-is', () => {
    expect(originIdOf({ originId: 'HAIFA' }, HOME)).toBe('HAIFA');
  });
});

describe('travelBetween() (REQUIREMENTS §13.93, ORIGINS_PLAN §4)', () => {
  const lookup = {
    travel: [{ fromId: 'X', toId: 'Y', distanceKm: 12, travelMinutes: 22 }],
    homeLocationId: HOME,
    destinations: { ...makeDestinations() },
    config: { defaultTravelMinutes: 60 },
  };
  it('the same place is 0/0', () => {
    expect(travelBetween(lookup, 'X', 'X')).toEqual({ minutes: 0, km: 0 });
  });
  it('a travel row matches either direction', () => {
    expect(travelBetween(lookup, 'X', 'Y')).toEqual({ minutes: 22, km: 12 });
    expect(travelBetween(lookup, 'Y', 'X')).toEqual({ minutes: 22, km: 12 });
  });
  it('home <-> X falls back to the destination\'s own figures', () => {
    expect(travelBetween(lookup, HOME, 'destA')).toEqual({ minutes: 30, km: 20 });
    expect(travelBetween(lookup, 'destA', HOME)).toEqual({ minutes: 30, km: 20 });
  });
  it('anything else falls back to config.defaultTravelMinutes with km undefined', () => {
    expect(travelBetween(lookup, 'Z', 'W')).toEqual({ minutes: 60, km: undefined });
  });
});

describe('explicit one_way trip type (REQUIREMENTS §13.93 item 4)', () => {
  it('places as a single relay leg, no pairing obligation, car ends at the destination', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        makeRequest({ id: 'R1', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'destB', departureMs: slotMs(32) }),
      ],
    });
    const output = solve(input);
    expect(output.unmet).toHaveLength(0);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride?.legs).toEqual([
      { requestId: 'R1', leg: 'out', carMode: 'relay', originId: HOME, destinationId: 'destB', role: 'driver' },
    ]);
    expect(ride?.originId).toBe(HOME);
    expect(ride?.destinationId).toBe('destB');
    // The car is left away at destB for the rest of the week — no obligation to bring it back.
    expect(output.carsAway.some((a) => a.carId === 'C1' && a.locationId === 'destB')).toBe(true);
  });

  it('the end-check rejects a placement that would strand an already-seeded fixed ride expecting the car at home', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      fixedRides: [
        {
          id: 'FX1',
          carId: 'C1',
          window: { start: 56, end: 72 },
          originId: HOME,
          destinationId: HOME,
          driverRequestId: 'FXR',
          driverMemberId: 'owner',
          legs: [{ requestId: 'FXR', leg: 'both', carMode: 'keep', originId: HOME, destinationId: 'destA', role: 'driver' }],
          servedRequestIds: ['FXR'],
          passengers: { adults: 1, childSeats: 0, boosters: 0 },
          luggageCount: 0,
          overnightAck: false,
          kind: 'pinned',
        },
      ],
      requests: [
        makeRequest({ id: 'R1', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'destB', departureMs: slotMs(32) }),
      ],
    });
    const output = solve(input);
    const unmet = output.unmet.find((u) => u.requestId === 'R1');
    expect(unmet?.reasonCode).toBe('UNMET_NO_CAR_AT_ORIGIN');
    expect(output.assignments.some((a) => a.servedRequestIds.includes('R1'))).toBe(false);
  });

  it('without the later fixed ride, the identical one-way request places fine (control case)', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        makeRequest({ id: 'R1', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'destB', departureMs: slotMs(32) }),
      ],
    });
    const output = solve(input);
    expect(output.assignments.some((a) => a.servedRequestIds.includes('R1'))).toBe(true);
  });
});

describe('drop_off (legacy one-way derivation) wraps the request\'s own origin (REQUIREMENTS §13.93)', () => {
  it('an unpaired relay-eligible leg from a non-home origin heals into a chauffeur ride wrapping that origin, not home', () => {
    const destinations = { ...makeDestinations(), HAIFA: { id: 'HAIFA', zone: 'zoneHaifa', distanceKm: 100, travelMinutes: 60 } };
    // Simplification (documented in the O4 report): the chauffeur heal wraps
    // the request's own origin as "origin -> X -> origin", generalizing the
    // legacy home -> X -> home formula exactly; it does not yet implement
    // the more general "wherever the car currently is" rule, so the car
    // must already be based at that origin for the heal to find it.
    const input = baseInput({
      cars: [makeCar('C1', { startLocationId: 'HAIFA' })],
      destinations,
      requests: [
        makeRequest({
          id: 'R1',
          tripShape: 'one_way_to',
          originId: 'HAIFA',
          destinationId: 'destA',
          departureMs: slotMs(32),
          canDrive: true,
        }),
      ],
    });
    const output = solve(input);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride?.reasonCode).toBe('PLACED_CHAUFFEUR_NO_RETURNER');
    expect(ride?.originId).toBe('HAIFA');
    expect(ride?.destinationId).toBe('HAIFA');
  });
});

describe('chauffeur "pickup" from the destination (REQUIREMENTS §13.93, owner follow-up 2026-10-04, ORIGINS_PLAN §3)', () => {
  it('"pick me up from Harish" (origin Harish, destination = home): every car at home still heals into a chauffeur ride, home -> Harish -> home, using the pickup window', () => {
    const destinations = { ...makeDestinations(), HARISH: { id: 'HARISH', zone: 'zoneHarish', distanceKm: 20, travelMinutes: 30 } };
    const input = baseInput({
      cars: [makeCar('C1')], // default startLocationId -> home
      destinations,
      requests: [
        makeRequest({ id: 'R1', tripShape: 'one_way_to', originId: 'HARISH', destinationId: HOME, departureMs: slotMs(32) }),
      ],
    });
    const output = solve(input);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride?.reasonCode).toBe('PLACED_CHAUFFEUR_NO_RETURNER');
    // The car wraps home -> Harish -> home (it was never at Harish to begin with).
    expect(ride?.originId).toBe(HOME);
    expect(ride?.destinationId).toBe(HOME);
    // Pickup window: [D - travel - dwell, D + travel) = [32-2-1, 32+2) = [29, 34)
    // (travelMinutes 30 -> 2 slots, chauffeurDwellMinutes 10 -> 1 slot, defaultConfig).
    expect(ride?.window).toEqual({ start: 29, end: 34 });
    // The person's own travel is still Harish -> home, unchanged by where the car starts.
    expect(ride?.legs).toEqual([
      { requestId: 'R1', leg: 'out', carMode: 'chauffeur', originId: 'HARISH', destinationId: HOME, role: 'passenger' },
    ]);
  });

  it('a drop_off from Haifa to Nahariya stays unmet when every car is at home (neither end is where the car is)', () => {
    const destinations = {
      ...makeDestinations(),
      HAIFA: { id: 'HAIFA', zone: 'zoneHaifa', distanceKm: 100, travelMinutes: 60 },
      NAHARIYA: { id: 'NAHARIYA', zone: 'zoneNahariya', distanceKm: 110, travelMinutes: 65 },
    };
    const input = baseInput({
      cars: [makeCar('C1')], // default startLocationId -> home
      destinations,
      requests: [
        makeRequest({ id: 'R1', tripShape: 'one_way_to', originId: 'HAIFA', destinationId: 'NAHARIYA', departureMs: slotMs(32) }),
      ],
    });
    const output = solve(input);
    expect(output.assignments.some((a) => a.servedRequestIds.includes('R1'))).toBe(false);
    const unmet = output.unmet.find((u) => u.requestId === 'R1');
    expect(unmet).toBeDefined();
  });
});

describe('free-text origin is never placed (REQUIREMENTS §13.93 item 5)', () => {
  it('ends up unmet with UNMET_FREE_TEXT_ORIGIN even though the car is entirely free', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', originIsFreeText: true, departureMs: slotMs(32), returnMs: slotMs(48) })],
    });
    const output = solve(input);
    expect(output.assignments).toHaveLength(0);
    expect(output.unmet).toHaveLength(1);
    expect(output.unmet[0]).toMatchObject({ requestId: 'R1', reasonCode: 'UNMET_FREE_TEXT_ORIGIN' });
  });
});

describe('changeOrigin suggestion (REQUIREMENTS §13.93, ORIGINS_PLAN §4 item 6)', () => {
  it('suggests the place a car is free for the whole requested window, when the request\'s own origin cannot be served', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      fixedRides: [
        {
          id: 'FX1',
          carId: 'C1',
          window: { start: 0, end: 8 },
          originId: HOME,
          destinationId: 'destB',
          driverRequestId: 'FXR1',
          driverMemberId: 'owner',
          legs: [{ requestId: 'FXR1', leg: 'out', carMode: 'relay', originId: HOME, destinationId: 'destB', role: 'driver' }],
          servedRequestIds: ['FXR1'],
          passengers: { adults: 1, childSeats: 0, boosters: 0 },
          luggageCount: 0,
          overnightAck: false,
          kind: 'pinned',
        },
        {
          id: 'FX2',
          carId: 'C1',
          window: { start: 80, end: 88 },
          originId: 'destB',
          destinationId: HOME,
          driverRequestId: 'FXR2',
          driverMemberId: 'owner',
          legs: [{ requestId: 'FXR2', leg: 'return', carMode: 'relay', originId: 'destB', destinationId: HOME, role: 'driver' }],
          servedRequestIds: ['FXR2'],
          passengers: { adults: 1, childSeats: 0, boosters: 0 },
          luggageCount: 0,
          overnightAck: false,
          kind: 'pinned',
        },
      ],
      requests: [
        makeRequest({ id: 'R1', destinationId: 'destA', departureMs: slotMs(20), returnMs: slotMs(60) }),
      ],
    });
    const output = solve(input);
    const unmet = output.unmet.find((u) => u.requestId === 'R1');
    expect(unmet).toBeDefined();
    const suggestion = unmet?.suggestions.find((s) => s.kind === 'changeOrigin');
    expect(suggestion).toMatchObject({ kind: 'changeOrigin', carId: 'C1', originId: 'destB' });
  });

  // The car sits at destB between FX1 and FX2 (slots 8–80); FX2 needs it back at destB.
  function awayCarInput(request: Request) {
    return baseInput({
      cars: [makeCar('C1')],
      fixedRides: [
        {
          id: 'FX1',
          carId: 'C1',
          window: { start: 0, end: 8 },
          originId: HOME,
          destinationId: 'destB',
          driverRequestId: 'FXR1',
          driverMemberId: 'owner',
          legs: [{ requestId: 'FXR1', leg: 'out', carMode: 'relay', originId: HOME, destinationId: 'destB', role: 'driver' }],
          servedRequestIds: ['FXR1'],
          passengers: { adults: 1, childSeats: 0, boosters: 0 },
          luggageCount: 0,
          overnightAck: false,
          kind: 'pinned',
        },
        {
          id: 'FX2',
          carId: 'C1',
          window: { start: 80, end: 88 },
          originId: 'destB',
          destinationId: HOME,
          driverRequestId: 'FXR2',
          driverMemberId: 'owner',
          legs: [{ requestId: 'FXR2', leg: 'return', carMode: 'relay', originId: 'destB', destinationId: HOME, role: 'driver' }],
          servedRequestIds: ['FXR2'],
          passengers: { adults: 1, childSeats: 0, boosters: 0 },
          luggageCount: 0,
          overnightAck: false,
          kind: 'pinned',
        },
      ],
      requests: [request],
    });
  }

  it('is not offered for a one-leg drop_off — the SQL origin proposal cannot place it (DATA_MODEL O3)', () => {
    const output = solve(awayCarInput(makeRequest({ id: 'R1', destinationId: 'destA', tripShape: 'one_way_to', tripType: 'drop_off', departureMs: slotMs(20) })));
    // R4B7 (REQ §13.104): the parked-away car now serves it as a chauffeur ride; either way no changeOrigin.
    const unmet = output.unmet.find((u) => u.requestId === 'R1');
    expect(unmet?.suggestions.some((s) => s.kind === 'changeOrigin') ?? false).toBe(false);
  });

  it('is not offered for a one_way that would strand the car\'s next ride (same end check as placement)', () => {
    const output = solve(awayCarInput(makeRequest({ id: 'R1', destinationId: 'destA', tripShape: 'one_way_to', tripType: 'one_way', departureMs: slotMs(20) })));
    const unmet = output.unmet.find((u) => u.requestId === 'R1');
    expect(unmet?.suggestions.some((s) => s.kind === 'changeOrigin')).toBe(false);
  });
});

describe('car location persists across days and weeks regardless of origin (REQUIREMENTS §13.93 item 7)', () => {
  const destinations = { ...makeDestinations(), HAIFA: { id: 'HAIFA', zone: 'zoneHaifa', distanceKm: 100, travelMinutes: 60 } };

  it('a one_way to Haifa on Tuesday makes a Wednesday round trip from home impossible on that car', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      destinations,
      requests: [
        makeRequest({ id: 'TUE', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'HAIFA', departureMs: slotMs(192 + 32) }),
        makeRequest({ id: 'WED_HOME', destinationId: 'destA', departureMs: slotMs(288 + 32), returnMs: slotMs(288 + 48) }),
      ],
    });
    const output = solve(input);
    expect(output.assignments.some((a) => a.servedRequestIds.includes('TUE'))).toBe(true);
    expect(output.unmet.some((u) => u.requestId === 'WED_HOME')).toBe(true);
  });

  it('...but the same Wednesday round trip from Haifa is possible on that car', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      destinations,
      requests: [
        makeRequest({ id: 'TUE', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'HAIFA', departureMs: slotMs(192 + 32) }),
        makeRequest({ id: 'WED_HAIFA', originId: 'HAIFA', destinationId: 'destA', departureMs: slotMs(288 + 32), returnMs: slotMs(288 + 48) }),
      ],
    });
    const output = solve(input);
    expect(output.assignments.some((a) => a.servedRequestIds.includes('TUE'))).toBe(true);
    expect(output.assignments.some((a) => a.servedRequestIds.includes('WED_HAIFA'))).toBe(true);
  });

  it('a car whose startLocationId is Haifa at week start serves a Haifa-origin request directly', () => {
    const input = baseInput({
      cars: [makeCar('C1', { startLocationId: 'HAIFA' })],
      destinations,
      requests: [makeRequest({ id: 'R1', originId: 'HAIFA', destinationId: 'destA', departureMs: slotMs(32), returnMs: slotMs(48) })],
    });
    const output = solve(input);
    expect(output.assignments.some((a) => a.servedRequestIds.includes('R1'))).toBe(true);
  });

  it('...but the same car cannot serve a home-origin request that same week (it never visited home)', () => {
    const input = baseInput({
      cars: [makeCar('C1', { startLocationId: 'HAIFA' })],
      destinations,
      requests: [makeRequest({ id: 'R1', destinationId: 'destA', departureMs: slotMs(32), returnMs: slotMs(48) })],
    });
    const output = solve(input);
    expect(output.unmet.some((u) => u.requestId === 'R1')).toBe(true);
  });
});

describe('location-neutral reservation (REQUIREMENTS §13.96)', () => {
  it('a reservation labelled with another place between two home rides changes nothing about where the car is', () => {
    const fixed = (id: string, start: number, end: number, place: string, extra: object = {}) => ({
      id,
      carId: 'C1',
      window: { start, end },
      originId: place,
      destinationId: place,
      legs: [],
      servedRequestIds: [],
      passengers: { adults: 0, childSeats: 0, boosters: 0 },
      luggageCount: 0,
      overnightAck: false,
      kind: 'pinned' as const,
      ...extra,
    });
    const input = baseInput({
      cars: [makeCar('C1')],
      fixedRides: [fixed('FXA', 8, 16, HOME), fixed('RES', 30, 40, 'destB', { locationNeutral: true }), fixed('FXB', 70, 78, HOME)],
      requests: [makeRequest({ id: 'R1', destinationId: 'destA', departureMs: slotMs(48), returnMs: slotMs(56) })],
    });
    const output = solve(input);
    expect(output.warnings.some((w) => w.code === 'CHAIN_BROKEN')).toBe(false);
    expect(output.carsAway).toEqual([]);
    expect(output.unmet).toEqual([]);
    expect(output.assignments.find((a) => a.source === 'solver')?.originId).toBe(HOME);
  });
});
