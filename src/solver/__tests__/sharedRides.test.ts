// REQUIREMENTS item 136 (a), docs/SOLVER.md §3.6.4: the pooling pass seats placed round trips as passengers
// of another placed ride going the same way, inside everyone's flexibility, and retries the unmet on the freed cars.
import { describe, expect, it } from 'vitest';
import { assertInvariants } from '../invariants';
import { solve } from '../index';
import type { Assignment, FixedRide, SolverInput } from '../types';
import { baseInput, defaultConfig, flex, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';

const DEP = 32;
const RET = 48;

const rq = (id: string, extra: Parameters<typeof makeRequest>[0] = {}) =>
  makeRequest({ id, memberId: `m-${id}`, memberName: `name-${id}`, departureMs: slotMs(DEP), returnMs: slotMs(RET), submittedAtMs: id.charCodeAt(0), ...extra });

const rideOf = (o: { assignments: Assignment[] }, id: string) => o.assignments.find((a) => a.servedRequestIds.includes(id));
const off = defaultConfig({ sharedRides: false });

function twoCars(requests: ReturnType<typeof rq>[], extra: Partial<SolverInput> = {}): SolverInput {
  return baseInput({ cars: [makeCar('C1'), makeCar('C2')], requests, ...extra });
}

describe('shared rides: pooling pass (REQ 136 a)', () => {
  it('two identical round trips share one ride; the lower-priority one is the passenger and a car stays free', () => {
    const input = twoCars([rq('A'), rq('B')]);
    const o = solve(input);
    assertInvariants(input, o);
    expect(o.unmet).toEqual([]);
    expect(o.assignments).toHaveLength(1);
    const ride = o.assignments[0]!;
    expect(ride.servedRequestIds).toEqual(['A', 'B']);
    expect(ride.driverRequestId).toBe('A');
    expect(ride.legs.find((l) => l.requestId === 'B')).toEqual({ requestId: 'B', leg: 'both', carMode: 'passenger', role: 'passenger', originId: 'home', destinationId: 'destA' });
    expect(ride.passengers).toEqual(passengers(2));
    expect(ride.reasonCode).toBe('PLACED_SHARED');
    expect(ride.reason).toContain('name-A');
    expect(ride.reason).toContain('name-B');
    expect(o.stats.served).toBe(2);
    expect(new Set(o.assignments.map((a) => a.carId)).size).toBe(1);
  });

  it('the freed car goes to a request that was unmet before', () => {
    // C overlaps A and B but is outside their flexibility (no pooling for it): with two cars it is unmet without pooling
    const requests = [rq('A'), rq('B'), rq('C', { departureMs: slotMs(DEP + 4), returnMs: slotMs(RET + 4) })];
    const without = solve(twoCars(requests, { config: off }));
    expect(without.unmet.map((u) => u.requestId)).toEqual(['C']);
    const input = twoCars(requests);
    const o = solve(input);
    assertInvariants(input, o);
    expect(o.unmet).toEqual([]);
    expect(rideOf(o, 'A')).toBe(rideOf(o, 'B'));
    expect(rideOf(o, 'C')?.carId).not.toBe(rideOf(o, 'A')?.carId);
    expect(o.stats.served).toBe(3);
  });

  it('never pools two free-text destinations: they share one pseudo id but are different places (replay 18.10)', () => {
    const free = { destinationId: '__free_text__', destinationIsFreeText: true };
    const o = solve(twoCars([rq('A', { ...free, destinationText: 'Yakum' }), rq('B', { ...free, destinationText: 'the north' })]));
    expect(o.assignments).toHaveLength(2);
    expect(o.assignments.every((a) => a.reasonCode !== 'PLACED_SHARED')).toBe(true);
  });

  it('does not pool when the guest time is outside its flexibility', () => {
    const o = solve(twoCars([rq('A'), rq('B', { departureMs: slotMs(DEP + 4), returnMs: slotMs(RET + 4) })]));
    expect(o.assignments).toHaveLength(2);
    expect(o.assignments.every((a) => a.reasonCode !== 'PLACED_SHARED')).toBe(true);
  });

  describe('added driving must keep the host inside its own flexibility', () => {
    // host to destB, guest to destA which lies on the way: +10 min per leg -> the ride starts/ends one slot outside
    const travel = [{ fromId: 'destA', toId: 'destB', travelMinutes: 20, distanceKm: 10 }];
    const guest = () => rq('G', { destinationId: 'destA', flexDeparture: flex(30, 30), flexReturn: flex(30, 30), submittedAtMs: 9 });
    it('no pooling when the host has no flexibility', () => {
      const o = solve(twoCars([rq('H', { destinationId: 'destB', submittedAtMs: 1 }), guest()], { travel }));
      expect(o.assignments).toHaveLength(2);
      expect(o.assignments.every((a) => a.reasonCode !== 'PLACED_SHARED')).toBe(true);
    });
    it('pools when the host allows the extended window', () => {
      const input = twoCars([rq('H', { destinationId: 'destB', submittedAtMs: 1, flexDeparture: flex(30, 30), flexReturn: flex(30, 30) }), guest()], { travel });
      const o = solve(input);
      assertInvariants(input, o);
      expect(o.assignments).toHaveLength(1);
      const ride = o.assignments[0]!;
      expect(ride.reasonCode).toBe('PLACED_SHARED');
      expect(ride.window.start).toBeLessThan(DEP);
      expect(ride.window.end).toBeGreaterThan(RET);
    });
  });

  it('does not pool when the seats are full', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(1)] }), makeCar('C2', { seatConfigs: [passengers(1)] })];
    const o = solve(baseInput({ cars, requests: [rq('A'), rq('B')] }));
    expect(o.assignments).toHaveLength(2);
  });

  it('does not pool large luggage into a car without a big trunk', () => {
    // A needs child seats (only C1 has them, no trunk), so A cannot ride in C2; B's luggage cannot ride in C1
    const requests = [rq('A', { passengers: passengers(1, 1) }), rq('B', { luggage: true })];
    const cars = (trunk: number) => [makeCar('C1', { seatConfigs: [passengers(4, 1)], luggageCapacity: trunk }), makeCar('C2')];
    const o = solve(baseInput({ cars: cars(0), requests }));
    expect(o.assignments).toHaveLength(2);
    expect(rideOf(o, 'B')?.carId).toBe('C2');
    // control: the same with a big trunk on C1 pools B into A's ride
    const ok = solve(baseInput({ cars: cars(1), requests }));
    expect(ok.assignments).toHaveLength(1);
    expect(ok.assignments[0]?.luggageCount).toBe(1);
  });

  it('never seats a guest in a fixed ride, a temporary car or a series', () => {
    const fixed: FixedRide = {
      id: 'F', carId: 'C1', window: { start: DEP, end: RET }, originId: 'home', destinationId: 'home', driverRequestId: 'FIXREQ', driverMemberId: 'm-fix',
      legs: [{ requestId: 'FIXREQ', leg: 'both', carMode: 'keep', originId: 'home', destinationId: 'destA', role: 'driver' }],
      servedRequestIds: ['FIXREQ'], passengers: passengers(1), luggageCount: 0, overnightAck: false, kind: 'pinned',
    };
    const temp: FixedRide = { ...fixed, id: 'T', carId: 'TMP', driverRequestId: 'TREQ', servedRequestIds: ['TREQ'], legs: [{ ...fixed.legs[0]!, requestId: 'TREQ' }], kind: 'temporaryOwner' };
    const input = baseInput({
      cars: [makeCar('C1'), makeCar('C2'), makeCar('TMP', { type: 'temporary', ownerMemberId: 'm-fix' })],
      requests: [rq('A')],
      fixedRides: [fixed, temp],
    });
    const o = solve(input);
    assertInvariants(input, o);
    expect(o.assignments.find((a) => a.rideId === 'F')?.servedRequestIds).toEqual(['FIXREQ']);
    expect(o.assignments.find((a) => a.rideId === 'T')?.servedRequestIds).toEqual(['TREQ']);
    expect(rideOf(o, 'A')?.carId).toBe('C2');
  });

  it('never uses a multi-day series as a host', async () => {
    const { makeSeriesLegs } = await import('../__fixtures__/gen');
    const series = makeSeriesLegs({ seriesId: 'S', seriesCount: 1, dayIndices: [0], departureSlotOfDay: DEP, returnSlotOfDay: RET });
    const input = twoCars([...series, rq('A', { submittedAtMs: 100 })]);
    const o = solve(input);
    assertInvariants(input, o);
    expect(rideOf(o, 'A')?.servedRequestIds).toEqual(['A']);
  });

  it('a non-driver pools into a driven ride (a gain: no driver needed)', () => {
    const input = twoCars([rq('A'), rq('N', { canDrive: false })]);
    const o = solve(input);
    assertInvariants(input, o);
    expect(o.assignments).toHaveLength(1);
    expect(o.assignments[0]?.driverRequestId).toBe('A');
    expect(o.assignments[0]?.servedRequestIds).toEqual(['A', 'N']);
    expect(o.stats.needsDriver).toBe(0);
    expect(solve(twoCars([rq('A'), rq('N', { canDrive: false })], { config: off })).stats.needsDriver).toBe(1);
  });

  it('sharedRides: false reproduces the unpooled output', () => {
    const o = solve(twoCars([rq('A'), rq('B')], { config: off }));
    expect(o.assignments).toHaveLength(2);
    expect(o.assignments.map((a) => a.servedRequestIds)).toEqual([['A'], ['B']]);
    expect(o.assignments.every((a) => a.legs.length === 1 && a.reasonCode !== 'PLACED_SHARED')).toBe(true);
  });

  it('a one-way or drop-off request is never a guest', () => {
    const o = solve(twoCars([rq('A'), rq('B', { tripType: 'one_way', tripShape: 'one_way_to', needsCarAtDestination: true })]));
    expect(o.assignments.every((a) => a.reasonCode !== 'PLACED_SHARED')).toBe(true);
  });

  it('is deterministic', () => {
    const input = twoCars([rq('A'), rq('B'), rq('C'), rq('D', { destinationId: 'destB' })]);
    expect(solve(input)).toEqual(solve(input));
  });
});

describe('unmet round trips take a seat directly (REQ 136 a)', () => {
  it('an unmet round trip joins a ride going the same way instead of waiting for a merge suggestion', () => {
    const one = (extra: Partial<SolverInput> = {}) =>
      baseInput({ cars: [makeCar('C1', { seatConfigs: [passengers(4)] })], requests: [rq('A'), rq('B')], ...extra });
    const without = solve(one({ config: off }));
    expect(without.unmet.map((u) => u.requestId)).toEqual(['B']);
    expect(without.unmet[0]?.suggestions.some((s) => s.kind === 'merge')).toBe(true);
    const input = one();
    const o = solve(input);
    assertInvariants(input, o);
    expect(o.unmet).toEqual([]);
    expect(o.assignments).toHaveLength(1);
    expect(o.assignments[0]?.reasonCode).toBe('PLACED_SHARED');
    expect(o.assignments[0]?.legs.find((l) => l.requestId === 'B')?.carMode).toBe('passenger');
  });

  it('unmet requests compete for seats in priority order: the higher one gets the last seat', () => {
    const cars = [makeCar('C1', { seatConfigs: [passengers(2)] })];
    const o = solve(baseInput({ cars, requests: [rq('A'), rq('B'), rq('C')] }));
    expect(o.assignments).toHaveLength(1);
    expect(o.assignments[0]?.servedRequestIds).toEqual(['A', 'B']);
    expect(o.unmet.map((u) => u.requestId)).toEqual(['C']);
  });
});

describe('merge suggestions see the host request by ride id (host shift, durationLocked)', () => {
  const travel = [{ fromId: 'destA', toId: 'destB', travelMinutes: 20, distanceKm: 10 }];
  const oneCar = (requests: ReturnType<typeof rq>[]) =>
    baseInput({ cars: [makeCar('C1', { seatConfigs: [passengers(4)] })], travel, requests });
  const guest = (extra: Parameters<typeof makeRequest>[0] = {}) =>
    rq('G', { destinationId: 'destA', canDrive: false, departureMs: slotMs(DEP + 1), returnMs: slotMs(RET + 3), submittedAtMs: 9, ...extra });

  it('a merge that needs the host to shift inside its flexibility is suggested (not placed: the added driving leaves the host window)', () => {
    const host = rq('H', { destinationId: 'destB', rideType: 'healthcare', submittedAtMs: 1, flexDeparture: flex(0, 30), flexReturn: flex(0, 30) });
    const o = solve(oneCar([host, guest()]));
    const unmet = o.unmet.find((u) => u.requestId === 'G');
    expect(unmet).toBeDefined();
    const merge = unmet?.suggestions.find((s) => s.kind === 'merge');
    expect(merge).toBeDefined();
    if (merge?.kind === 'merge') {
      expect(merge.hostShift?.departureMin).toBe(30);
      expect(merge.hostShift?.returnMin).toBe(30);
    }
  });

  it('a durationLocked host is refused a merge that adds driving', () => {
    const lockedHost = rq('H', {
      destinationId: 'destB', rideType: 'healthcare', submittedAtMs: 1, durationLocked: true,
      flexDeparture: flex(0, 60), flexReturn: flex(0, 60),
    });
    const o = solve(oneCar([lockedHost, guest({ departureMs: slotMs(DEP), returnMs: slotMs(RET), flexDeparture: flex(30, 30), flexReturn: flex(30, 30) })]));
    const unmet = o.unmet.find((u) => u.requestId === 'G');
    expect(unmet).toBeDefined();
    expect(unmet?.suggestions.some((s) => s.kind === 'merge')).toBe(false);
    // control: the same host without the lock may take the merge suggestion
    const free = solve(oneCar([{ ...lockedHost, durationLocked: false }, guest({ departureMs: slotMs(DEP), returnMs: slotMs(RET), flexDeparture: flex(30, 30), flexReturn: flex(30, 30) })]));
    expect(free.unmet.find((u) => u.requestId === 'G')?.suggestions.some((s) => s.kind === 'merge')).toBe(true);
  });
});

