// REQUIREMENTS item 136 (f), docs/SOLVER.md §3.6.5: preferred cars are answered in a fixing stage.

import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { assertInvariants } from '../invariants';
import { runPreferenceSwaps } from '../preferenceSwaps';
import type { PlacedSingle } from '../greedy';
import { normalize } from '../slots';
import { buildTimelines } from '../timeline';
import { baseInput, makeCar, makeRequest, passengers, slotMs } from '../__fixtures__/gen';
import type { FixedRide, Request, SolverInput } from '../types';

const noPool = (input: Partial<SolverInput>): SolverInput => {
  const b = baseInput(input);
  return { ...b, config: { ...b.config, sharedRides: false } };
};
const at = (o: ReturnType<typeof solve>, id: string) => o.assignments.find((a) => a.servedRequestIds.includes(id));
const check = (input: SolverInput) => {
  const out = solve(input);
  expect(() => assertInvariants(input, out)).not.toThrow();
  expect(JSON.stringify(solve(input))).toBe(JSON.stringify(out));
  return out;
};
// Y outranks X (healthcare vs errands), so Y is placed first and takes the first car by id.
const high = (extra: Partial<Request> = {}) =>
  makeRequest({ id: 'Y', memberId: 'my', rideType: 'healthcare', destinationId: 'destB', departureMs: slotMs(32), returnMs: slotMs(48), ...extra });
const low = (extra: Partial<Request> = {}) =>
  makeRequest({ id: 'X', memberId: 'mx', rideType: 'errands', departureMs: slotMs(32), returnMs: slotMs(48), ...extra });

function fixedRide(id: string, carId: string, start: number, end: number, originId: string, destinationId: string): FixedRide {
  return {
    id, carId, window: { start, end }, originId, destinationId, driverRequestId: `${id}-req`, driverMemberId: `${id}-m`,
    legs: [{ requestId: `${id}-req`, leg: 'both', carMode: 'keep', originId, destinationId, role: 'driver' }],
    servedRequestIds: [`${id}-req`], passengers: passengers(1), luggageCount: 0, overnightAck: false, kind: 'pinned',
  };
}

describe('item 136 (f): preference swaps', () => {
  it('swaps two simultaneous rides so the lower-priority preference is answered; windows unchanged', () => {
    const input = noPool({ cars: [makeCar('a-car'), makeCar('b-car')], requests: [high(), low({ preferredCarId: 'a-car' })] });
    const out = check(input);
    expect(at(out, 'X')?.carId).toBe('a-car');
    expect(at(out, 'X')?.reasonCode).toBe('PLACED_PREFERRED_CAR');
    expect(at(out, 'X')?.reason).toContain('a-car');
    expect(at(out, 'Y')?.carId).toBe('b-car');
    expect(at(out, 'Y')?.reasonCode).not.toBe('PLACED_PREFERRED_CAR');
    expect(out.unmet).toEqual([]);
    expect(out.stats.preferenceSwaps).toBe(1);
    const withoutPref = solve(noPool({ cars: [makeCar('a-car'), makeCar('b-car')], requests: [high(), low()] }));
    for (const id of ['X', 'Y']) expect(at(out, id)?.window).toEqual(at(withoutPref, id)?.window);
  });

  it('does not swap when the other ride does not fit the car it would move to (seats)', () => {
    const input = noPool({
      cars: [makeCar('a-car', { seatConfigs: [passengers(7)] }), makeCar('b-car')],
      requests: [high({ passengers: passengers(5) }), low({ preferredCarId: 'a-car' })],
    });
    const out = check(input);
    expect(at(out, 'Y')?.carId).toBe('a-car');
    expect(at(out, 'X')?.carId).toBe('b-car');
    expect(out.stats.preferenceSwaps ?? 0).toBe(0);
  });

  it('does not swap when the other ride needs the big trunk or child seats of its car', () => {
    const trunk = check(noPool({
      cars: [makeCar('a-car', { luggageCapacity: 2 }), makeCar('b-car', { luggageCapacity: 0 })],
      requests: [high({ luggage: true }), low({ preferredCarId: 'a-car' })],
    }));
    expect(at(trunk, 'Y')?.carId).toBe('a-car');
    expect(at(trunk, 'X')?.carId).toBe('b-car');
    const kids = check(noPool({
      cars: [makeCar('a-car', { seatConfigs: [passengers(2, 2, 0)] }), makeCar('b-car')],
      requests: [high({ passengers: passengers(2, 1, 0) }), low({ preferredCarId: 'a-car' })],
    }));
    expect(at(kids, 'Y')?.carId).toBe('a-car');
    expect(at(kids, 'X')?.carId).toBe('b-car');
  });

  it('does not swap when nothing improves (the other ride also prefers its own car)', () => {
    const out = check(noPool({
      cars: [makeCar('a-car'), makeCar('b-car')],
      requests: [high({ preferredCarId: 'a-car' }), low({ preferredCarId: 'a-car' })],
    }));
    expect(at(out, 'Y')?.carId).toBe('a-car');
    expect(at(out, 'X')?.carId).toBe('b-car');
    expect(out.stats.preferenceSwaps ?? 0).toBe(0);
  });

  it('never moves a fixed ride, even when it blocks the preferred car', () => {
    const input = noPool({
      cars: [makeCar('a-car'), makeCar('b-car')],
      requests: [low({ preferredCarId: 'a-car' })],
      fixedRides: [fixedRide('FX', 'a-car', 32, 48, 'home', 'home')],
    });
    const out = check(input);
    expect(at(out, 'X')?.carId).toBe('b-car');
    expect(out.assignments.find((a) => a.rideId === 'FX')?.carId).toBe('a-car');
  });

  it('is deterministic under input reordering', () => {
    const input = noPool({ cars: [makeCar('a-car'), makeCar('b-car')], requests: [high(), low({ preferredCarId: 'a-car' })] });
    expect(solve({ ...input, cars: [...input.cars].reverse(), requests: [...input.requests].reverse() })).toEqual(solve(input));
  });
});

// Direct pass tests: hand-built plans, so each rule is exercised on its own.
describe('item 136 (f): runPreferenceSwaps on a hand-built plan', () => {
  function plan(input: SolverInput, onCar: Record<string, string>, guests: Record<string, string[]> = {}) {
    const { normalized } = normalize(input);
    const nrs = new Map(normalized.map((n) => [n.id, n]));
    const timelines = buildTimelines(input.cars, 2, 96 * 7, input.homeLocationId);
    for (const fr of input.fixedRides) {
      timelines.get(fr.carId)?.forceAdd({ rideId: fr.id, window: fr.window, startLocationId: fr.originId, endLocationId: fr.destinationId, overnightAck: false });
    }
    const placed: PlacedSingle[] = [];
    for (const [id, carId] of Object.entries(onCar)) {
      const nr = nrs.get(id)!;
      const leg = nr.legs[0]!;
      timelines.get(carId)!.add({ rideId: `ride:${id}`, window: nr.window, startLocationId: leg.originId, endLocationId: leg.destinationId, overnightAck: false });
      placed.push({ kind: 'single', nr, carId, window: nr.window, shift: { departureMin: 0, returnMin: 0 }, guests: (guests[id] ?? []).map((g) => nrs.get(g)!) });
    }
    const scores = new Map(normalized.map((n) => [n.id, { total: n.id === 'X' ? 1 : 0 }]));
    const carsMap = new Map(input.cars.map((c) => [c.id, c]));
    return { placed, timelines, run: () => runPreferenceSwaps(placed, timelines, input, scores, carsMap) };
  }

  it('moves a ride onto a free preferred car (simple move)', () => {
    const input = noPool({ cars: [makeCar('a-car'), makeCar('b-car')], requests: [low({ preferredCarId: 'a-car' })] });
    const p = plan(input, { X: 'b-car' });
    expect(p.run().swaps).toBe(1);
    expect(p.placed[0]?.carId).toBe('a-car');
    expect(p.placed[0]?.preferredCar).toBe(true);
    expect(p.timelines.get('a-car')?.has('ride:X')).toBe(true);
    expect(p.timelines.get('b-car')?.has('ride:X')).toBe(false);
  });

  it('moves a pooled host together with its guests, and only when everyone seats', () => {
    const guest = makeRequest({ id: 'G', memberId: 'mg', departureMs: slotMs(32), returnMs: slotMs(48), passengers: passengers(2) });
    const cars = [makeCar('a-car', { seatConfigs: [passengers(3)] }), makeCar('b-car', { seatConfigs: [passengers(4)] })];
    const input = noPool({ cars, requests: [low({ preferredCarId: 'a-car' }), guest] });
    // host 1 + guest 2 = 3 adults: fits the 3-seater
    const ok = plan(input, { X: 'b-car' }, { X: ['G'] });
    expect(ok.run().swaps).toBe(1);
    expect(ok.placed[0]?.carId).toBe('a-car');
    expect(ok.placed[0]?.guests).toHaveLength(1);
    // a bigger guest group no longer fits the preferred car
    const big = makeRequest({ id: 'G', memberId: 'mg', departureMs: slotMs(32), returnMs: slotMs(48), passengers: passengers(3) });
    const no = plan(noPool({ cars, requests: [low({ preferredCarId: 'a-car' }), big] }), { X: 'b-car' }, { X: ['G'] });
    expect(no.run().swaps).toBe(0);
    expect(no.placed[0]?.carId).toBe('b-car');
  });

  it('does not swap when a partner would break a later ride\'s location chain', () => {
    // Y is a one-way home -> destB on a-car, followed there by a ride from destB; moving it to b-car
    // (whose next ride starts at home) would leave the chain broken.
    const y = makeRequest({ id: 'Y', memberId: 'my', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'destB', departureMs: slotMs(32) });
    const input = noPool({
      cars: [makeCar('a-car'), makeCar('b-car')],
      requests: [low({ preferredCarId: 'a-car' }), y],
      fixedRides: [fixedRide('FA', 'a-car', 60, 70, 'destB', 'home'), fixedRide('FB', 'b-car', 60, 70, 'home', 'home')],
    });
    const p = plan(input, { X: 'b-car', Y: 'a-car' });
    expect(p.run().swaps).toBe(0);
    expect(p.placed.find((s) => s.nr.id === 'X')?.carId).toBe('b-car');
    expect(p.placed.find((s) => s.nr.id === 'Y')?.carId).toBe('a-car');
    expect(p.timelines.get('a-car')?.has('ride:Y')).toBe(true);
    expect(p.timelines.get('b-car')?.has('ride:X')).toBe(true);
  });

  it('does not swap when a partner would end the week away from its car\'s base', () => {
    const y = makeRequest({ id: 'Y', memberId: 'my', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'destB', departureMs: slotMs(32) });
    const input = noPool({
      cars: [makeCar('a-car'), makeCar('b-car')],
      requests: [low({ preferredCarId: 'a-car' }), y],
      fixedRides: [fixedRide('FA', 'a-car', 60, 70, 'destB', 'home')],
    });
    const p = plan(input, { X: 'b-car', Y: 'a-car' });
    expect(p.run().swaps).toBe(0);
  });
});
