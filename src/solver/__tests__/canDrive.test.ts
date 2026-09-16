// Non-driver members and mode-less one-way requests (REQUIREMENTS §13.88,
// rule made precise 2026-09-16; docs/SOLVER.md §1.3.8-9, §3.6.1a). Covers:
//  (a) a non-driver round trip is placed driverless, or offered as a merge
//      suggestion into a same-way ride when it cannot be placed on its own;
//  (b) a one-way leg's mode is decided by pairing, not the member: an
//      eligible-driver leg is a relay *candidate*, resolved to a real relay
//      leg when paired, a standalone chauffeur ride when not; a no-driver
//      leg is passenger unconditionally;
//  (c) an unpaired relay candidate is healed as a standalone chauffeur
//      placement instead of being left unmet, and never leaves the car
//      waiting at the destination;
//  (d) a driving companion becomes the leg's driver when the requester
//      cannot drive;
//  (e) the stored (legacy) `oneWayCarMode` is ignored entirely, for drivers
//      and non-drivers alike.

import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { normalize } from '../slots';
import { baseInput, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';

describe('canDrive === false: round trips (REQUIREMENTS §13.88)', () => {
  it('places a non-driver round trip driverless on a free car', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', canDrive: false, departureMs: slotMs(32), returnMs: slotMs(48) })],
    });
    const output = solve(input);
    expect(output.unmet).toHaveLength(0);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride).toBeDefined();
    expect(ride?.driverRequestId).toBeUndefined();
    expect(ride?.driverMemberId).toBeUndefined();
    expect(ride?.legs[0]?.role).toBe('passenger');
    expect(ride?.reasonCode).toBe('PLACED_NEEDS_DRIVER');
    expect(output.stats.needsDriver).toBe(1);
  });

  it('never gives a non-driver the driver role, even alone with a free car and default canDrive on others', () => {
    const input = baseInput({
      cars: [makeCar('C1'), makeCar('C2')],
      requests: [
        makeRequest({ id: 'driver', departureMs: slotMs(32), returnMs: slotMs(48) }),
        makeRequest({ id: 'nonDriver', canDrive: false, departureMs: slotMs(32), returnMs: slotMs(48) }),
      ],
    });
    const output = solve(input);
    const driverRide = output.assignments.find((a) => a.servedRequestIds.includes('driver'));
    const nonDriverRide = output.assignments.find((a) => a.servedRequestIds.includes('nonDriver'));
    expect(driverRide?.legs[0]?.role).toBe('driver');
    expect(nonDriverRide?.legs[0]?.role).toBe('passenger');
    expect(nonDriverRide?.driverRequestId).toBeUndefined();
  });

  it('offers a merge suggestion (seats in another ride) when a non-driver round trip cannot get its own car', () => {
    const input = baseInput({
      cars: [makeCar('C1', { seatConfigs: [passengers(4)] })],
      requests: [
        makeRequest({ id: 'host', departureMs: slotMs(32), returnMs: slotMs(48), passengers: passengers(1), submittedAtMs: 0 }),
        makeRequest({ id: 'guest', canDrive: false, departureMs: slotMs(32), returnMs: slotMs(48), passengers: passengers(1), submittedAtMs: 1 }),
      ],
    });
    const output = solve(input);
    const guestUnmet = output.unmet.find((u) => u.requestId === 'guest');
    expect(guestUnmet).toBeDefined();
    const merge = guestUnmet?.suggestions.find((s) => s.kind === 'merge');
    expect(merge).toBeDefined();
    if (merge?.kind === 'merge') {
      expect(merge.guestRequestIds).toEqual(['guest']);
    }
  });
});

describe('one-way requests without a stated mode (REQUIREMENTS §13.88)', () => {
  it('a driver defaults to a relay candidate — placed as a real relay leg only when paired, chauffeured otherwise', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_to', departureMs: slotMs(32) })],
    });
    const nr = normalize(input).normalized[0]!;
    expect(nr.legs[0]?.preferredMode).toBe('relay');

    // No partner exists in this fixture, so the candidate is healed as a
    // standalone chauffeur ride (§3.6.1a), never left as a warning and never
    // placed as a lone `relay` leg (that would leave the car at the destination).
    const output = solve(input);
    expect(output.unmet).toHaveLength(0);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride?.legs[0]?.carMode).toBe('chauffeur');
    expect(ride?.legs[0]?.role).toBe('passenger');
    expect(ride?.driverRequestId).toBeUndefined();
    expect(ride?.driverMemberId).toBeUndefined();
    expect(ride?.reasonCode).toBe('PLACED_CHAUFFEUR_NO_RETURNER');
    expect(output.stats.needsDriver).toBe(1);
  });

  it('a non-driver defaults to passenger and merges into a same-way host', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        makeRequest({ id: 'host', departureMs: slotMs(32), returnMs: slotMs(48) }),
        makeRequest({ id: 'guest', tripShape: 'one_way_to', canDrive: false, departureMs: slotMs(32) }),
      ],
    });
    const nr = normalize(input).normalized.find((r) => r.id === 'guest')!;
    expect(nr.isPassengerOnly).toBe(true);

    const output = solve(input);
    const guestUnmet = output.unmet.find((u) => u.requestId === 'guest');
    expect(guestUnmet).toBeDefined();
    const merge = guestUnmet?.suggestions.find((s) => s.kind === 'merge');
    expect(merge).toBeDefined();
  });

  it('a non-driver with no host falls back to a chauffeur suggestion', () => {
    const input = baseInput({
      cars: [makeCar('C1', { seatConfigs: [passengers(4)] })],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_to', canDrive: false, departureMs: slotMs(40) })],
    });
    const output = solve(input);
    const unmet = output.unmet.find((u) => u.requestId === 'R1');
    expect(unmet).toBeDefined();
    const chauffeur = unmet?.suggestions.find((s) => s.kind === 'chauffeur');
    expect(chauffeur).toBeDefined();
    expect(unmet?.suggestions.some((s) => s.kind === 'merge')).toBe(false);
  });
});

describe('an unpaired relay candidate becomes a standalone chauffeur placement (REQUIREMENTS §13.88/§13.89)', () => {
  it('a lone relay out-leg is placed as a chauffeur ride — never as a lone relay leg, no relocation', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_to', departureMs: slotMs(80) })],
    });
    const output = solve(input);

    expect(output.unmet).toHaveLength(0);
    expect(output.assignments).toHaveLength(1); // no separate relocation ride
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride).toBeDefined();
    expect(ride?.carId).toBe('C1');
    expect(ride?.legs[0]?.carMode).toBe('chauffeur');
    expect(ride?.legs[0]?.role).toBe('passenger');
    expect(ride?.legs[0]?.originId).toBe('home');
    expect(ride?.legs[0]?.destinationId).toBe('destA');
    expect(ride?.driverRequestId).toBeUndefined();
    expect(ride?.driverMemberId).toBeUndefined();
    expect(ride?.pairedRideId).toBeUndefined();
    // home round trip wrapped around the leg: [D, D + 2*travel(2) + dwell(1)) = [80, 85)
    expect(ride?.originId).toBe('home');
    expect(ride?.destinationId).toBe('home');
    expect(ride?.window).toEqual({ start: 80, end: 85 });
    expect(ride?.reasonCode).toBe('PLACED_CHAUFFEUR_NO_RETURNER');

    expect(output.stats.needsDriver).toBe(1);
  });

  it('a lone relay return-leg (one_way_from) is placed as a chauffeur pick-up ride', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_from', returnMs: slotMs(20) })],
    });
    const output = solve(input);

    expect(output.unmet).toHaveLength(0);
    expect(output.assignments).toHaveLength(1);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride).toBeDefined();
    expect(ride?.legs[0]?.carMode).toBe('chauffeur');
    expect(ride?.legs[0]?.role).toBe('passenger');
    expect(ride?.legs[0]?.originId).toBe('destA');
    expect(ride?.legs[0]?.destinationId).toBe('home');
    expect(ride?.driverRequestId).toBeUndefined();
    expect(ride?.driverMemberId).toBeUndefined();
    expect(ride?.pairedRideId).toBeUndefined();
    // [R - 2*travel(2) - dwell(1), R) = [20-5, 20) = [15, 20)
    expect(ride?.originId).toBe('home');
    expect(ride?.destinationId).toBe('home');
    expect(ride?.window).toEqual({ start: 15, end: 20 });

    expect(output.stats.needsDriver).toBe(1);
  });

  it('still falls back to UNMET_NO_RELAY_PARTNER when no car has room for the whole chauffeur window', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        // occupies the car almost the entire day so no room exists for the chauffeur window either
        makeRequest({ id: 'blocker', departureMs: slotMs(0), returnMs: slotMs(94) }),
        makeRequest({ id: 'R1', tripShape: 'one_way_to', departureMs: slotMs(20) }),
      ],
    });
    const output = solve(input);
    const unmet = output.unmet.find((u) => u.requestId === 'R1');
    // the out-leg cannot even start (car busy with the blocker) — a genuine
    // UNMET_NO_CAR, not something the chauffeur heal pass ever gets a chance to see.
    expect(unmet).toBeDefined();
  });
});

describe('driving companions (REQUIREMENTS §13.88, owner 2026-09-16)', () => {
  it('a non-driver requester paired with a driver return-leg makes a relay pair, the companion driving', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        makeRequest({
          id: 'O1',
          memberId: 'non-driver',
          tripShape: 'one_way_to',
          canDrive: false,
          drivingCompanionIds: ['comp-1'],
          departureMs: slotMs(36),
        }),
        makeRequest({ id: 'R1', memberId: 'driver-member', tripShape: 'one_way_from', returnMs: slotMs(48) }),
      ],
    });
    const output = solve(input);
    expect(output.unmet).toHaveLength(0);

    const outRide = output.assignments.find((a) => a.servedRequestIds.includes('O1'));
    expect(outRide?.legs[0]?.carMode).toBe('relay');
    expect(outRide?.legs[0]?.role).toBe('passenger'); // the requester themself never drives
    expect(outRide?.driverRequestId).toBe('O1'); // still "O1's leg" — the driver is named separately
    expect(outRide?.driverMemberId).toBe('comp-1');

    const retRide = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(retRide?.legs[0]?.role).toBe('driver');
    expect(retRide?.driverMemberId).toBe('driver-member');
    expect(retRide?.carId).toBe(outRide?.carId);
    expect(outRide?.pairedRideId).toBe(retRide?.rideId);
  });

  it('a non-driver requester with no driving companion is a passenger candidate, never a relay leg', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'O1', tripShape: 'one_way_to', canDrive: false, departureMs: slotMs(36) })],
    });
    const nr = normalize(input).normalized[0]!;
    expect(nr.isPassengerOnly).toBe(true);
    expect(nr.legs[0]?.preferredMode).toBe('passenger');
  });
});

describe('stored (legacy) oneWayCarMode is ignored entirely (REQUIREMENTS §13.88, rule made precise 2026-09-16)', () => {
  it('a driver explicitly requesting passenger mode is ignored — still a relay candidate', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        makeRequest({ id: 'host', departureMs: slotMs(32), returnMs: slotMs(48) }),
        makeRequest({ id: 'guest', tripShape: 'one_way_to', oneWayCarMode: 'passenger', departureMs: slotMs(32) }),
      ],
    });
    const nr = normalize(input).normalized.find((r) => r.id === 'guest')!;
    expect(nr.isPassengerOnly).toBe(false);
    expect(nr.legs[0]?.preferredMode).toBe('relay');
  });

  it('a driver with a stored passenger mode and no partner is chauffeured, not merged as a passenger', () => {
    const input = baseInput({
      cars: [makeCar('C1', { seatConfigs: [passengers(4)] })],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_to', oneWayCarMode: 'passenger', departureMs: slotMs(40) })],
    });
    const output = solve(input);
    expect(output.unmet).toHaveLength(0);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride?.legs[0]?.carMode).toBe('chauffeur');
    expect(ride?.reasonCode).toBe('PLACED_CHAUFFEUR_NO_RETURNER');
  });

  it('a non-driver is passenger regardless of an explicit legacy oneWayCarMode: relay', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_to', oneWayCarMode: 'relay', canDrive: false, departureMs: slotMs(32) })],
    });
    const nr = normalize(input).normalized[0]!;
    expect(nr.isPassengerOnly).toBe(true);
    expect(nr.legs[0]?.preferredMode).toBe('passenger');
  });
});

describe('two eligible-driver legs at the same destination pair into one relay pair (REQUIREMENTS §13.88)', () => {
  it('places two relay legs on one car, away at the destination in between — never two chauffeur rides', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        makeRequest({ id: 'O1', tripShape: 'one_way_to', departureMs: slotMs(36) }),
        makeRequest({ id: 'R1', tripShape: 'one_way_from', returnMs: slotMs(48) }),
      ],
    });
    const output = solve(input);
    expect(output.unmet).toHaveLength(0);

    const outRide = output.assignments.find((a) => a.servedRequestIds.includes('O1'));
    const retRide = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(outRide?.legs[0]?.carMode).toBe('relay');
    expect(retRide?.legs[0]?.carMode).toBe('relay');
    expect(outRide?.carId).toBe(retRide?.carId);
    expect(outRide?.pairedRideId).toBe(retRide?.rideId);
    expect(output.carsAway.some((a) => a.carId === outRide?.carId && a.locationId === 'destA')).toBe(true);
    expect(output.stats.needsDriver).toBe(0);
  });
});

describe('a chauffeur window that would cross midnight never becomes a placement (day-boundary guard)', () => {
  it('a departure late enough that [D, D+2*travel+dwell) spills past day end falls back to unmet, never throws', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_to', departureMs: slotMs(94) })], // day has 96 slots
    });
    expect(() => solve(input)).not.toThrow();
    const output = solve(input);
    expect(output.assignments.some((a) => a.servedRequestIds.includes('R1'))).toBe(false);
    const unmet = output.unmet.find((u) => u.requestId === 'R1');
    expect(unmet).toBeDefined();
    expect(unmet?.reasonCode).toBe('UNMET_NO_RELAY_PARTNER');
  });
});
