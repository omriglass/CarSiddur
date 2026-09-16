// Non-driver members and mode-less one-way requests (REQUIREMENTS §13.88,
// §13.89; docs/SOLVER.md §1.3.8-9, §3.6.1a). Covers:
//  (a) a non-driver round trip is placed driverless, or offered as a merge
//      suggestion into a same-way ride when it cannot be placed on its own;
//  (b) an absent oneWayCarMode resolves to relay for a driver, passenger
//      (then chauffeur) for a non-driver;
//  (c) a lone relay leg is healed with an auto-generated needs-driver
//      relocation ride instead of being left unmet;
//  (d) an explicit legacy oneWayCarMode is still honoured for a driver, and
//      still downgraded to passenger for a non-driver.

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
  it('a driver defaults to relay (and gets placed/healed, never left as a warning)', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_to', departureMs: slotMs(32) })],
    });
    const nr = normalize(input).normalized[0]!;
    expect(nr.legs[0]?.preferredMode).toBe('relay');

    const output = solve(input);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride?.legs[0]?.carMode).toBe('relay');
    expect(ride?.legs[0]?.role).toBe('driver');
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

describe('a lone relay leg heals with a needs-driver relocation ride (REQUIREMENTS §13.89)', () => {
  it('a lone relay out-leg is placed, and a driverless return relocation closes the day-end loop', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_to', oneWayCarMode: 'relay', departureMs: slotMs(80) })],
    });
    const output = solve(input);

    expect(output.unmet).toHaveLength(0);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride).toBeDefined();
    expect(ride?.carId).toBe('C1');
    expect(ride?.legs[0]?.carMode).toBe('relay');
    expect(ride?.legs[0]?.role).toBe('driver');
    expect(ride?.originId).toBe('home');
    expect(ride?.destinationId).toBe('destA');
    expect(ride?.window).toEqual({ start: 80, end: 82 }); // travelSlots(destA) = 2

    const reloc = output.assignments.find((a) => a.rideId === ride?.pairedRideId);
    expect(reloc).toBeDefined();
    expect(reloc?.carId).toBe('C1');
    expect(reloc?.driverRequestId).toBeUndefined();
    expect(reloc?.driverMemberId).toBeUndefined();
    expect(reloc?.servedRequestIds).toEqual([]);
    expect(reloc?.originId).toBe('destA');
    expect(reloc?.destinationId).toBe('home');
    expect(reloc?.window).toEqual({ start: 93, end: 95 }); // [dayEnd(95) - travelSlots(2), dayEnd)
    expect(reloc?.reasonCode).toBe('PLACED_NEEDS_DRIVER');
    expect(reloc?.pairedRideId).toBe(ride?.rideId);

    expect(output.stats.needsDriver).toBe(1);
  });

  it('a lone relay return-leg (one_way_from) heals with a driverless out relocation right before it', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_from', oneWayCarMode: 'relay', returnMs: slotMs(20) })],
    });
    const output = solve(input);

    expect(output.unmet).toHaveLength(0);
    const ride = output.assignments.find((a) => a.servedRequestIds.includes('R1'));
    expect(ride).toBeDefined();
    expect(ride?.legs[0]?.carMode).toBe('relay');
    expect(ride?.originId).toBe('destA');
    expect(ride?.destinationId).toBe('home');
    expect(ride?.window).toEqual({ start: 18, end: 20 }); // travelSlots = 2

    const reloc = output.assignments.find((a) => a.rideId === ride?.pairedRideId);
    expect(reloc).toBeDefined();
    expect(reloc?.driverRequestId).toBeUndefined();
    expect(reloc?.originId).toBe('home');
    expect(reloc?.destinationId).toBe('destA');
    // right before the leg, minus the standard buffer (30 min = 2 slots): [18-2-2, 18-2) = [14, 16)
    expect(reloc?.window).toEqual({ start: 14, end: 16 });

    expect(output.stats.needsDriver).toBe(1);
  });

  it('still falls back to UNMET_NO_RELAY_PARTNER when no car has room for the healing leg', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        // occupies the car almost the entire day so the healing return has no room at day end
        makeRequest({ id: 'blocker', departureMs: slotMs(0), returnMs: slotMs(94) }),
        makeRequest({ id: 'R1', tripShape: 'one_way_to', oneWayCarMode: 'relay', departureMs: slotMs(20) }),
      ],
    });
    const output = solve(input);
    const unmet = output.unmet.find((u) => u.requestId === 'R1');
    // the out-leg cannot even start (car busy with the blocker) — a genuine
    // UNMET_NO_CAR, not something the heal pass ever gets a chance to see.
    expect(unmet).toBeDefined();
  });
});

describe('explicit legacy oneWayCarMode is still honoured (REQUIREMENTS §13.88)', () => {
  it('a driver explicitly requesting passenger mode is not switched to relay', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        makeRequest({ id: 'host', departureMs: slotMs(32), returnMs: slotMs(48) }),
        makeRequest({ id: 'guest', tripShape: 'one_way_to', oneWayCarMode: 'passenger', departureMs: slotMs(32) }),
      ],
    });
    const nr = normalize(input).normalized.find((r) => r.id === 'guest')!;
    expect(nr.isPassengerOnly).toBe(true);
    expect(nr.legs[0]?.preferredMode).toBe('passenger');
  });

  it('a non-driver is downgraded to passenger even if oneWayCarMode explicitly says relay', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_to', oneWayCarMode: 'relay', canDrive: false, departureMs: slotMs(32) })],
    });
    const nr = normalize(input).normalized[0]!;
    expect(nr.isPassengerOnly).toBe(true);
    expect(nr.legs[0]?.preferredMode).toBe('passenger');
  });
});
