// REQUIREMENTS item 136 (b), docs/SOLVER.md §3.6.6-§3.6.7: a drop-off leg rides along in a ride passing by before it
// can become a chauffeur ride; up to 30 min beyond its flexibility it is a merge proposal; a driverless ride never
// takes a car a driver needs.
import { describe, expect, it } from 'vitest';
import { evictDriverlessForDrivers } from '../driverFirst';
import type { Unit } from '../greedy';
import { assertInvariants } from '../invariants';
import { solve } from '../index';
import { normalize } from '../slots';
import { buildTimelines } from '../timeline';
import type { Assignment, FixedRide, SolverInput } from '../types';
import { baseInput, defaultConfig, flex, makeCar, makeRequest, slotMs } from '../__fixtures__/gen';

const DEP = 32;
const RET = 48;

const host = (id = 'H', extra: Parameters<typeof makeRequest>[0] = {}) =>
  makeRequest({ id, memberId: `m-${id}`, memberName: `name-${id}`, departureMs: slotMs(DEP), returnMs: slotMs(RET), submittedAtMs: 1, ...extra });
const dropOff = (id: string, extra: Parameters<typeof makeRequest>[0] = {}) =>
  makeRequest({ id, memberId: `m-${id}`, memberName: `name-${id}`, tripShape: 'one_way_to', canDrive: false, departureMs: slotMs(DEP), submittedAtMs: 9, ...extra });
const pickup = (id: string, extra: Parameters<typeof makeRequest>[0] = {}) =>
  makeRequest({ id, memberId: `m-${id}`, memberName: `name-${id}`, tripShape: 'one_way_from', canDrive: false, returnMs: slotMs(RET), submittedAtMs: 9, ...extra });
const rideOf = (o: { assignments: Assignment[] }, id: string) => o.assignments.find((a) => a.servedRequestIds.includes(id));
const check = (input: SolverInput) => {
  const o = solve(input);
  assertInvariants(input, o);
  return o;
};

describe('a drop-off rides along first (REQ 136 b)', () => {
  it('a drop-off leaving with a ride going there is a passenger of it: no chauffeur, no driverless ride', () => {
    const o = check(baseInput({ cars: [makeCar('C1'), makeCar('C2')], requests: [host(), dropOff('G')] }));
    expect(o.unmet).toEqual([]);
    expect(o.assignments).toHaveLength(1);
    const ride = rideOf(o, 'G')!;
    expect(ride.driverRequestId).toBe('H');
    expect(ride.legs.find((l) => l.requestId === 'G')).toEqual({
      requestId: 'G', leg: 'out', carMode: 'passenger', role: 'passenger', originId: 'home', destinationId: 'destA',
    });
    expect(ride.reasonCode).toBe('PLACED_SHARED');
    expect(o.assignments.some((a) => !a.driverRequestId && !a.driverMemberId)).toBe(false);
    expect(o.stats.needsDriver).toBe(0);
    expect(o.stats.served).toBe(2);
  });

  it('a pickup leg rides along on the host\'s return leg', () => {
    const o = check(baseInput({ cars: [makeCar('C1'), makeCar('C2')], requests: [host(), pickup('G')] }));
    expect(o.unmet).toEqual([]);
    expect(o.assignments).toHaveLength(1);
    expect(rideOf(o, 'G')?.legs.find((l) => l.requestId === 'G')).toEqual({
      requestId: 'G', leg: 'return', carMode: 'passenger', role: 'passenger', originId: 'destA', destinationId: 'home',
    });
  });

  it('the two halves of one drop-off with a pickup may ride in two different rides', () => {
    const both = makeRequest({
      id: 'G', memberId: 'm-G', canDrive: false, needsCarAtDestination: false, departureMs: slotMs(DEP), returnMs: slotMs(RET + 8), submittedAtMs: 9,
    });
    const o = check(baseInput({ cars: [makeCar('C1'), makeCar('C2')], requests: [host(), host('H2', { returnMs: slotMs(RET + 8), submittedAtMs: 2 }), both] }));
    expect(o.unmet).toEqual([]);
    const legs = o.assignments.flatMap((a) => a.legs.filter((l) => l.requestId === 'G').map((l) => ({ ride: a.rideId, leg: l.leg })));
    expect(legs.map((l) => l.leg).sort()).toEqual(['out', 'return']);
    expect(o.assignments.every((a) => a.driverRequestId !== undefined)).toBe(true);
  });

  it('outside the flexibility but within 30 minutes: no seat, a merge suggestion on a leg that stays unmet', () => {
    // one car, busy with the host; the guest leaves 15 min after the host and neither has flexibility
    const o = check(baseInput({ cars: [makeCar('C1')], requests: [host(), dropOff('G', { departureMs: slotMs(DEP + 1) })] }));
    expect(rideOf(o, 'G')).toBeUndefined();
    const u = o.unmet.find((x) => x.requestId === 'G')!;
    const merge = u.suggestions.find((s) => s.kind === 'merge');
    expect(merge).toMatchObject({ kind: 'merge', hostRideId: 'ride:H', leg: 'out', reasonCode: 'SUGGEST_MERGE_BEYOND_FLEX' });
    // it ranks before the external hints and the deny
    expect(u.suggestions.indexOf(merge!)).toBeLessThan(u.suggestions.findIndex((s) => s.kind === 'deny'));
  });

  it('31+ minutes beyond the flexibility is no merge suggestion', () => {
    const o = check(baseInput({ cars: [makeCar('C1')], requests: [host(), dropOff('G', { departureMs: slotMs(DEP + 3) })] }));
    expect(o.unmet.find((x) => x.requestId === 'G')?.suggestions.some((s) => s.kind === 'merge')).toBe(false);
  });

  it('nobody passing by: the leg is a chauffeur ride as before', () => {
    const o = check(baseInput({ cars: [makeCar('C1')], requests: [dropOff('G')] }));
    const ride = rideOf(o, 'G')!;
    expect(ride.legs[0]?.carMode).toBe('chauffeur');
    expect(ride.reasonCode).toBe('PLACED_NEEDS_DRIVER');
    expect(o.stats.needsDriver).toBe(1);
  });

  it('a host to another place is not passed by', () => {
    const o = check(baseInput({ cars: [makeCar('C1'), makeCar('C2')], requests: [host('H', { destinationId: 'destB' }), dropOff('G')] }));
    expect(rideOf(o, 'G')?.legs[0]?.carMode).toBe('chauffeur');
  });

  describe('the host stays inside its own flexibility', () => {
    // host to destB, guest to destA on the way: +10 min on the out leg -> the ride would start one slot early
    const travel = [{ fromId: 'destA', toId: 'destB', travelMinutes: 20, distanceKm: 10 }];
    const guest = () => dropOff('G', { destinationId: 'destA', flexDeparture: flex(30, 30) });
    it('no seat when the detour would move the host outside its flexibility', () => {
      const o = check(baseInput({ cars: [makeCar('C1'), makeCar('C2')], travel, requests: [host('H', { destinationId: 'destB' }), guest()] }));
      expect(rideOf(o, 'G')?.legs.find((l) => l.requestId === 'G')?.carMode).toBe('chauffeur');
    });
    it('a seat when the host allows the extended window', () => {
      const o = check(baseInput({
        cars: [makeCar('C1'), makeCar('C2')], travel,
        requests: [host('H', { destinationId: 'destB', flexDeparture: flex(30, 30), flexReturn: flex(30, 30) }), guest()],
      }));
      const ride = rideOf(o, 'G')!;
      expect(ride.driverRequestId).toBe('H');
      expect(ride.window.start).toBeLessThan(DEP);
    });
  });

  it('seats and luggage are respected', () => {
    const cars = [makeCar('C1', { seatConfigs: [{ adults: 1, childSeats: 0, boosters: 0 }] }), makeCar('C2', { seatConfigs: [{ adults: 1, childSeats: 0, boosters: 0 }] })];
    const o = check(baseInput({ cars, requests: [host(), dropOff('G')] }));
    expect(rideOf(o, 'H')?.servedRequestIds).toEqual(['H']);
    // luggage: a car without a large trunk takes no luggage guest
    const trunkless = [makeCar('C1', { luggageCapacity: 0 }), makeCar('C2', { luggageCapacity: 0 })];
    const l = check(baseInput({ cars: trunkless, requests: [host(), dropOff('G', { luggage: true })] }));
    expect(rideOf(l, 'H')?.servedRequestIds).toEqual(['H']);
  });

  it('never rides along in a fixed ride', () => {
    const fixed: FixedRide = {
      id: 'F', carId: 'C1', window: { start: DEP, end: RET }, originId: 'home', destinationId: 'home', driverRequestId: 'FIXREQ', driverMemberId: 'm-fix',
      legs: [{ requestId: 'FIXREQ', leg: 'both', carMode: 'keep', originId: 'home', destinationId: 'destA', role: 'driver' }],
      servedRequestIds: ['FIXREQ'], passengers: { adults: 1, childSeats: 0, boosters: 0 }, luggageCount: 0, overnightAck: false, kind: 'pinned',
    };
    const o = check(baseInput({ cars: [makeCar('C1'), makeCar('C2')], requests: [dropOff('G')], fixedRides: [fixed] }));
    expect(o.assignments.find((a) => a.rideId === 'F')?.servedRequestIds).toEqual(['FIXREQ']);
    expect(rideOf(o, 'G')?.legs[0]?.carMode).toBe('chauffeur');
  });

  it('config.sharedRides = false keeps the chauffeur path', () => {
    const o = check(baseInput({ cars: [makeCar('C1'), makeCar('C2')], config: defaultConfig({ sharedRides: false }), requests: [host(), dropOff('G')] }));
    expect(rideOf(o, 'G')?.legs[0]?.carMode).toBe('chauffeur');
  });

  it('is deterministic: the same input gives the same output, whatever the request order', () => {
    const requests = [host(), host('H2', { submittedAtMs: 2 }), dropOff('G'), dropOff('G2', { submittedAtMs: 10 }), pickup('P')];
    const a = solve(baseInput({ cars: [makeCar('C1'), makeCar('C2')], requests }));
    const b = solve(baseInput({ cars: [makeCar('C2'), makeCar('C1')], requests: [...requests].reverse() }));
    expect(b).toEqual(a);
  });
});

describe('a driverless ride never takes a car a driver needs (REQ 136 b)', () => {
  // N (cannot drive, earlier submission = higher priority) takes the only car; D drives and overlaps N
  const nonDriver = (extra: Parameters<typeof makeRequest>[0] = {}) =>
    makeRequest({ id: 'N', memberId: 'm-N', memberName: 'name-N', canDrive: false, departureMs: slotMs(36), returnMs: slotMs(48), submittedAtMs: 1, ...extra });
  const driver = () =>
    makeRequest({ id: 'D', memberId: 'm-D', memberName: 'name-D', destinationId: 'destB', departureMs: slotMs(40), returnMs: slotMs(52), submittedAtMs: 5 });

  it('the needs-driver round trip is evicted; the driver is placed; the evicted request is unmet with the new reason', () => {
    const input = baseInput({ cars: [makeCar('C1')], requests: [nonDriver({ destinationId: 'destB' }), driver()] });
    const o = check(input);
    expect(rideOf(o, 'D')?.driverRequestId).toBe('D');
    expect(rideOf(o, 'N')).toBeUndefined();
    const u = o.unmet.find((x) => x.requestId === 'N')!;
    expect(u.reasonCode).toBe('UNMET_CAR_TO_DRIVER');
    expect(u.reason).toContain('name-D');
    expect(u.reason).not.toContain('D"');
    expect(u.suggestions.some((s) => s.kind === 'deny')).toBe(true);
    expect(o.stats.needsDriver).toBe(0);
  });

  it('a driver request is not displaced by a driver request (nobody is evicted when the rides have drivers)', () => {
    const other = makeRequest({ id: 'E', memberId: 'm-E', destinationId: 'destB', departureMs: slotMs(36), returnMs: slotMs(48), submittedAtMs: 1 });
    const o = check(baseInput({ cars: [makeCar('C1')], requests: [other, driver()] }));
    expect(rideOf(o, 'E')?.driverRequestId).toBe('E');
    expect(o.unmet.map((u) => u.requestId)).toEqual(['D']);
    expect(o.unmet[0]?.reasonCode).not.toBe('UNMET_CAR_TO_DRIVER');
  });

  it('an evicted round trip that can ride along with the driver is served as his guest instead', () => {
    const same = driver();
    const n = nonDriver({ destinationId: 'destB', departureMs: same.departureMs, returnMs: same.returnMs });
    const o = check(baseInput({ cars: [makeCar('C1')], requests: [n, same] }));
    expect(o.unmet).toEqual([]);
    expect(rideOf(o, 'D')).toBe(rideOf(o, 'N'));
    expect(rideOf(o, 'D')?.driverRequestId).toBe('D');
  });

  it('never evicts a fixed ride, even a driverless one', () => {
    const fixed: FixedRide = {
      id: 'F', carId: 'C1', window: { start: 36, end: 48 }, originId: 'home', destinationId: 'home', driverRequestId: undefined, driverMemberId: undefined,
      legs: [{ requestId: 'FIXREQ', leg: 'both', carMode: 'keep', originId: 'home', destinationId: 'destB', role: 'passenger' }],
      servedRequestIds: ['FIXREQ'], passengers: { adults: 1, childSeats: 0, boosters: 0 }, luggageCount: 0, overnightAck: false, kind: 'pinned',
    };
    const o = check(baseInput({ cars: [makeCar('C1')], requests: [driver()], fixedRides: [fixed] }));
    expect(o.assignments.find((a) => a.rideId === 'F')?.source).toBe('fixed');
    expect(rideOf(o, 'D')).toBeUndefined();
    expect(o.unmet.find((u) => u.requestId === 'D')).toBeDefined();
  });

  it('a chauffeur ride is evicted for a driver request that then fits (unit)', () => {
    const input = baseInput({ cars: [makeCar('C1')], requests: [driver()] });
    const { normalized } = normalize(input);
    const nr = normalized[0]!;
    const timelines = buildTimelines(input.cars, 2, 7 * 96, 'home');
    const chauffeur: Assignment = {
      rideId: 'ride:X', carId: 'C1', window: { start: 38, end: 46 }, originId: 'home', destinationId: 'home',
      legs: [{ requestId: 'X', leg: 'out', carMode: 'chauffeur', originId: 'home', destinationId: 'destA', role: 'passenger' }],
      servedRequestIds: ['X'], passengers: { adults: 1, childSeats: 0, boosters: 0 }, luggageCount: 0,
      shift: { departureMin: 0, returnMin: 0 }, source: 'solver', reasonCode: 'PLACED_CHAUFFEUR_NO_RETURNER', reason: '',
    };
    timelines.get('C1')!.add({ rideId: 'ride:X', window: chauffeur.window, startLocationId: 'home', endLocationId: 'home', overnightAck: false });
    const unit: Unit = { kind: 'single', id: 'D', score: 1, submittedAtMs: 5, single: nr };
    const res = evictDriverlessForDrivers([unit], [], [chauffeur], timelines, input);
    expect([...res.removedRideIds]).toEqual(['ride:X']);
    expect(res.evicted.get('X')).toBe('D');
    expect(res.newPlaced).toHaveLength(1);
    expect(timelines.get('C1')!.has('ride:X')).toBe(false);
    // control: a fixed-looking block that is not in the evictable list stays and nothing is placed
    const t2 = buildTimelines(input.cars, 2, 7 * 96, 'home');
    t2.get('C1')!.add({ rideId: 'ride:X', window: chauffeur.window, startLocationId: 'home', endLocationId: 'home', overnightAck: false });
    const none = evictDriverlessForDrivers([unit], [], [], t2, input);
    expect(none.newPlaced).toEqual([]);
    expect(t2.get('C1')!.has('ride:X')).toBe(true);
  });
});
