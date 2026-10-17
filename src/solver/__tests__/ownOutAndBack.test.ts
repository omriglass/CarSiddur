// REQ item 136 (d) / SOLVER §3.6.1d: one person's out and back is one trip.
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { baseInput, makeCar, makeRequest, slotMs } from '../__fixtures__/gen';
import type { FixedRide, Request, SolverInput } from '../types';

const HOME = 'home';
const DAY = 96;

// a fixed ride starting at home: a lone one-way X -> Y would strand it, a lone Y -> X finds no car at Y
function fixedHomeRide(carId: string, start: number, end: number): FixedRide {
  return {
    id: `FX-${carId}-${start}`, carId, window: { start, end }, originId: HOME, destinationId: HOME,
    driverRequestId: 'FXR', driverMemberId: 'owner',
    legs: [{ requestId: 'FXR', leg: 'both', carMode: 'keep', originId: HOME, destinationId: 'destA', role: 'driver' }],
    servedRequestIds: ['FXR'], passengers: { adults: 1, childSeats: 0, boosters: 0 }, luggageCount: 0,
    overnightAck: false, kind: 'pinned',
  } as FixedRide;
}

const out = (over: Partial<Request> = {}): Request =>
  makeRequest({ id: 'OUT', memberId: 'elisha', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'destB', departureMs: slotMs(28), ...over });
const back = (over: Partial<Request> = {}): Request =>
  makeRequest({ id: 'BACK', memberId: 'elisha', tripType: 'one_way', tripShape: 'one_way_to', originId: 'destB', destinationId: HOME, departureMs: slotMs(58), ...over });

const sameDay = (reqs: Request[] = [out(), back()], extra: Partial<SolverInput> = {}): SolverInput =>
  baseInput({ cars: [makeCar('C1')], requests: reqs, fixedRides: [fixedHomeRide('C1', 70, 80)], ...extra });

const overnight = (reqs: Request[], extra: Partial<SolverInput> = {}): SolverInput =>
  baseInput({ cars: [makeCar('C1')], requests: reqs, fixedRides: [fixedHomeRide('C1', DAY + 70, DAY + 80)], ...extra });

describe('item 136 (d): the same member out and back', () => {
  it('Elisha: to destB 07:00 and back 14:30 land on one car, paired, he drives both', () => {
    const o = solve(sameDay());
    expect(o.unmet).toEqual([]);
    const a = o.assignments.find((x) => x.servedRequestIds.includes('OUT'))!;
    const b = o.assignments.find((x) => x.servedRequestIds.includes('BACK'))!;
    expect(a.carId).toBe('C1');
    expect(b.carId).toBe('C1');
    expect(a.pairedRideId).toBe(b.rideId);
    expect(b.pairedRideId).toBe(a.rideId);
    expect(a.reasonCode).toBe('PLACED_RELAY_PAIR');
    expect(a.driverMemberId).toBe('elisha');
    expect(b.driverMemberId).toBe('elisha');
    expect(a.window.end).toBeLessThanOrEqual(b.window.start);
  });

  it('different members still pair on the same day', () => {
    const o = solve(sameDay([out({ memberId: 'm1' }), back({ memberId: 'm2' })]));
    expect(o.unmet).toEqual([]);
    expect(o.assignments.find((x) => x.servedRequestIds.includes('OUT'))?.pairedRideId).toBeDefined();
  });

  it('is deterministic', () => {
    expect(JSON.stringify(solve(sameDay()))).toBe(JSON.stringify(solve(sameDay())));
  });

  it('free-text places never pair', () => {
    const o = solve(sameDay([out({ destinationIsFreeText: true, destinationText: 'x' }), back({ originIsFreeText: true, originText: 'x' })]));
    expect(o.unmet.map((u) => u.requestId).sort()).toEqual(['BACK', 'OUT']);
  });
});

describe('item 136 (d): across a night', () => {
  const backNextDay = (): Request => back({ departureMs: slotMs(DAY + 28) });

  it('pairs when nobody needs the car in the wait', () => {
    const o = solve(overnight([out(), backNextDay()]));
    expect(o.unmet).toEqual([]);
    const a = o.assignments.find((x) => x.servedRequestIds.includes('OUT'))!;
    const b = o.assignments.find((x) => x.servedRequestIds.includes('BACK'))!;
    expect(a.carId).toBe(b.carId);
    expect(a.pairedRideId).toBe(b.rideId);
    expect(b.window.start).toBeGreaterThanOrEqual(DAY);
  });

  it('is refused when the wait is contested (one car, someone needs it meanwhile)', () => {
    const other = makeRequest({ id: 'OTHER', memberId: 'someone', destinationId: 'destA', departureMs: slotMs(DAY - 20 + 0), returnMs: slotMs(DAY + 10) });
    const o = solve(overnight([out(), backNextDay(), other]));
    const ids = o.unmet.map((u) => u.requestId);
    expect(ids).toContain('OUT');
    expect(ids).toContain('BACK');
  });
});

describe('item 136 (d): a nearby place for the way back', () => {
  const travel = [{ fromId: 'destB', toId: 'destA', travelMinutes: 15, distanceKm: 10 }];
  const farTravel = [{ fromId: 'destB', toId: 'destA', travelMinutes: 40, distanceKm: 30 }];
  const nearBack = (): Request => back({ originId: 'destA', departureMs: slotMs(DAY + 28) });

  it('back from a place 15 min away pairs; the back block starts early by the empty drive', () => {
    const o = solve(overnight([out(), nearBack()], { travel }));
    expect(o.unmet).toEqual([]);
    const a = o.assignments.find((x) => x.servedRequestIds.includes('OUT'))!;
    const b = o.assignments.find((x) => x.servedRequestIds.includes('BACK'))!;
    expect(a.carId).toBe(b.carId);
    expect(b.originId).toBe('destB'); // the car's place
    expect(b.legs[0]!.originId).toBe('destA'); // the member's place
    expect(b.window.start).toBe(DAY + 28 - 1);
  });

  it('a place beyond the detour limit does not pair', () => {
    const o = solve(overnight([out(), nearBack()], { travel: farTravel }));
    expect(o.unmet.map((u) => u.requestId)).toContain('OUT');
  });
});

describe('item 136 (d): the pair is a greedy unit, ranked by its higher leg', () => {
  it('outranks a lower-priority round trip that overlaps the wait on the only free car', () => {
    // one car, nothing stranded: the round trip (10:00-14:00 on the only car) would otherwise take it
    const low = makeRequest({
      id: 'LOW', memberId: 'other', destinationId: 'destA', departureMs: slotMs(40), returnMs: slotMs(56),
    });
    const o = solve(baseInput({ cars: [makeCar('C1')], requests: [low, out(), back()] }));
    const a = o.assignments.find((x) => x.servedRequestIds.includes('OUT'));
    const b = o.assignments.find((x) => x.servedRequestIds.includes('BACK'));
    expect(a?.pairedRideId).toBe(b?.rideId);
    expect(a?.carId).toBe('C1');
    expect(o.unmet.map((u) => u.requestId)).toEqual(['LOW']);
  });
});
