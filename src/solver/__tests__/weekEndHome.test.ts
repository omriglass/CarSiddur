// REQUIREMENTS item 136 (c), docs/SOLVER.md §1.3a / §3.13: the solver never places a ride (or a
// chain of rides) that leaves a shared car away from its base when the week ends. Only the final
// state of a placement unit counts: pairs end where they started.

import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { assertInvariants } from '../invariants';
import { baseInput, makeCar, makeRequest, makeSeriesLegs, slotMs } from '../__fixtures__/gen';
import type { FixedRide, SolverInput } from '../types';

const HOME = 'home';
const FRI = 5 * 96;

const oneWay = (id: string, extra: Parameters<typeof makeRequest>[0] = {}) =>
  makeRequest({ id, memberId: `m-${id}`, tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'destB', departureMs: slotMs(FRI + 32), ...extra });

function fixedRide(id: string, carId: string, start: number, end: number, originId: string, destinationId: string): FixedRide {
  return {
    id, carId, window: { start, end }, originId, destinationId, driverRequestId: `${id}-req`, driverMemberId: `${id}-m`,
    legs: [{ requestId: `${id}-req`, leg: 'both', carMode: 'keep', originId, destinationId, role: 'driver' }],
    servedRequestIds: [`${id}-req`], passengers: { adults: 1, childSeats: 0, boosters: 0 }, luggageCount: 0,
    overnightAck: false, kind: 'pinned',
  };
}

const placed = (o: ReturnType<typeof solve>, id: string) => o.assignments.some((a) => a.servedRequestIds.includes(id));
const check = (input: SolverInput) => {
  const out = solve(input);
  expect(() => assertInvariants(input, out)).not.toThrow();
  expect(JSON.stringify(solve(input))).toBe(JSON.stringify(out));
  return out;
};

describe('item 136 (c): never away from base at week end', () => {
  it('a lone one-way to a far place with nothing after it stays unmet with its own reason (the Nahariya case)', () => {
    const out = check(baseInput({ cars: [makeCar('C1')], requests: [oneWay('R1')] }));
    expect(placed(out, 'R1')).toBe(false);
    const u = out.unmet.find((x) => x.requestId === 'R1');
    expect(u?.reasonCode).toBe('UNMET_ONE_WAY_AWAY_AT_WEEK_END');
    expect(u?.reason).not.toMatch(/[0-9a-f]{8}-/);
    expect(out.warnings.some((w) => w.code === 'CAR_AWAY_AT_WEEK_END')).toBe(false);
  });

  it('keeps the ordinary one-way suggestion ladder (something still gets offered)', () => {
    const out = solve(baseInput({ cars: [makeCar('C1')], requests: [oneWay('R1')] }));
    expect(out.unmet.find((x) => x.requestId === 'R1')?.suggestions.length).toBeGreaterThan(0);
  });

  it('the same one-way is placed when a later ride on that car starts at the destination', () => {
    const out = check(baseInput({
      cars: [makeCar('C1')], requests: [oneWay('R1')],
      fixedRides: [fixedRide('FX', 'C1', FRI + 60, FRI + 72, 'destB', HOME)],
    }));
    expect(placed(out, 'R1')).toBe(true);
    expect(out.unmet).toEqual([]);
  });

  it('a one-way that ends at the car\'s base is placed', () => {
    const back = oneWay('R1', { originId: 'destB', destinationId: HOME });
    const out = check(baseInput({ cars: [makeCar('C1', { startLocationId: 'destB' })], requests: [back] }));
    expect(placed(out, 'R1')).toBe(true);
  });

  it('a one-way to the base of a car with a non-home base is placed', () => {
    const out = check(baseInput({ cars: [makeCar('C1', { baseLocationId: 'destB' })], requests: [oneWay('R1')] }));
    expect(placed(out, 'R1')).toBe(true);
  });

  it('a complementary one-way pair (out and back) is still placed', () => {
    const a = oneWay('A', { departureMs: slotMs(FRI + 32) });
    const b = oneWay('B', { originId: 'destB', destinationId: HOME, departureMs: slotMs(FRI + 48) });
    const out = check(baseInput({ cars: [makeCar('C1')], requests: [a, b] }));
    expect(placed(out, 'A')).toBe(true);
    expect(placed(out, 'B')).toBe(true);
  });

  it('a drop-off with a pickup (own #out/#ret pair) is still placed', () => {
    const r = makeRequest({ id: 'D', destinationId: 'destA', needsCarAtDestination: false, departureMs: slotMs(FRI + 36), returnMs: slotMs(FRI + 56) });
    const out = check(baseInput({ cars: [makeCar('C1')], requests: [r] }));
    expect(placed(out, 'D')).toBe(true);
  });

  it('a round trip is unaffected', () => {
    const r = makeRequest({ id: 'RT', destinationId: 'destB', departureMs: slotMs(FRI + 32), returnMs: slotMs(FRI + 48) });
    expect(placed(check(baseInput({ cars: [makeCar('C1')], requests: [r] })), 'RT')).toBe(true);
  });

  it('a series whose last leg is next week is still placed (the car is legitimately away, booked)', () => {
    const legs = makeSeriesLegs({ seriesId: 'S', seriesCount: 3, dayIndices: [5, 6] });
    const out = check(baseInput({ cars: [makeCar('C1')], requests: legs }));
    expect(out.unmet).toEqual([]);
    expect(legs.every((l) => placed(out, l.id))).toBe(true);
  });

  it('a car that starts the week away is not blocked from rides that do not move it', () => {
    const rt = makeRequest({ id: 'RT', originId: 'destB', destinationId: 'destA', departureMs: slotMs(32), returnMs: slotMs(48) });
    const out = check(baseInput({ cars: [makeCar('C1', { startLocationId: 'destB' })], requests: [rt] }));
    expect(placed(out, 'RT')).toBe(true);
  });

  it('a fixed ride that leaves the car away only produces the existing week-end warning', () => {
    const out = check(baseInput({ cars: [makeCar('C1')], fixedRides: [fixedRide('FX', 'C1', FRI + 32, FRI + 40, HOME, 'destB')] }));
    expect(out.warnings.some((w) => w.code === 'CAR_AWAY_AT_WEEK_END')).toBe(true);
  });
});
