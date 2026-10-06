// REQ §13.105 (QA run 5): R5B8 short own pair stays connected, 105a complementary one-way suggestion,
// 105b a pickup from X on a car standing at X.
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { pairRelays } from '../relay';
import { normalize } from '../slots';
import { baseInput, flex, makeCar, makeDestinations, makeRequest, slotMs } from '../__fixtures__/gen';

describe('R5B8: a short drop-off + pickup by a member who drives is one connected pair', () => {
  const own = (extra: Parameters<typeof makeRequest>[0] = {}) => [
    makeRequest({ id: 'X#out', splitFrom: 'X', tripShape: 'one_way_to', oneWayCarMode: 'relay', tripType: 'drop_off', departureMs: slotMs(36), ...extra }),
    makeRequest({ id: 'X#ret', splitFrom: 'X', tripShape: 'one_way_from', oneWayCarMode: 'relay', tripType: 'drop_off', returnMs: slotMs(42), ...extra }),
  ];
  const busy = [
    makeRequest({ id: 'Z1', destinationId: 'destB', departureMs: slotMs(37), returnMs: slotMs(44) }),
    makeRequest({ id: 'Z2', destinationId: 'destB', departureMs: slotMs(38), returnMs: slotMs(45) }),
  ];

  it('connects despite a contested wait when the wait is short (<= 2 x turnaround)', () => {
    const cars = [makeCar('C1'), makeCar('C2')];
    const { normalized } = normalize(baseInput({ cars, requests: [...own(), ...busy] }));
    const legs = normalized.filter((n) => n.legs[0]?.side !== 'both');
    const others = normalized.filter((n) => n.legs[0]?.side === 'both');
    expect(pairRelays(legs, cars, others).pairs).toHaveLength(0); // unchanged default
    expect(pairRelays(legs, cars, others, 4).pairs).toHaveLength(1);
  });

  it('keeps the legs separate when the wait is long', () => {
    const cars = [makeCar('C1'), makeCar('C2')];
    const longOwn = own().map((r) => (r.id === 'X#ret' ? { ...r, returnMs: slotMs(56) } : r));
    const { normalized } = normalize(baseInput({ cars, requests: [...longOwn, ...busy.map((b) => ({ ...b, returnMs: slotMs(52) }))] }));
    const legs = normalized.filter((n) => n.legs[0]?.side !== 'both');
    const others = normalized.filter((n) => n.legs[0]?.side === 'both');
    expect(pairRelays(legs, cars, others, 4).pairs).toHaveLength(0);
  });

  it('solve(): the two legs share one car and the requester drives', () => {
    const cars = [makeCar('C1'), makeCar('C2')];
    const requests = [
      makeRequest({ id: 'X', memberId: 'mX', rideType: 'healthcare', tripType: 'drop_off', needsCarAtDestination: false, departureMs: slotMs(36), returnMs: slotMs(42) }),
      ...busy.map((b) => ({ ...b, flexDeparture: flex(0, 'day' as const), flexReturn: flex(0, 'day' as const) })),
    ];
    const out = solve(baseInput({ cars, requests }));
    const rides = out.assignments.filter((a) => a.servedRequestIds.includes('X'));
    expect(rides.map((r) => r.legs[0]?.carMode)).toEqual(['relay', 'relay']);
    expect(new Set(rides.map((r) => r.carId)).size).toBe(1);
    expect(rides.every((r) => r.driverMemberId === 'mX' || r.driverRequestId === 'X')).toBe(true);
  });
});

describe('105b: a pickup from X uses a car standing at X, driven home by the requester', () => {
  const destinations = { ...makeDestinations(), HAD: { id: 'HAD', zone: 'zH', distanceKm: 30, travelMinutes: 30 } };
  const pickup = (extra: Parameters<typeof makeRequest>[0] = {}) =>
    makeRequest({ id: 'P', tripType: 'drop_off', tripShape: 'one_way_from', needsCarAtDestination: false, destinationId: 'HAD', returnMs: slotMs(60), ...extra });

  it('places the leg as one relay ride X -> home on the car at X, requester drives', () => {
    const o = solve(baseInput({ cars: [makeCar('C1', { startLocationId: 'HAD' })], destinations, requests: [pickup()] }));
    const a = o.assignments.find((x) => x.servedRequestIds.includes('P'));
    expect(o.unmet).toEqual([]);
    expect(a?.reasonCode).toBe('PLACED_PICKUP_FROM_CAR_AT_X');
    expect([a?.originId, a?.destinationId]).toEqual(['HAD', 'home']);
    expect(a?.legs[0]).toMatchObject({ carMode: 'relay', leg: 'return', role: 'driver' });
    expect(a?.driverRequestId).toBe('P');
    expect(a?.driverMemberId).toBeDefined();
  });
  it('a driving companion drives when the requester cannot', () => {
    const o = solve(baseInput({ cars: [makeCar('C1', { startLocationId: 'HAD' })], destinations,
      requests: [pickup({ id: 'P', memberId: 'kid', canDrive: false, drivingCompanionIds: ['adult'] })] }));
    const a = o.assignments.find((x) => x.servedRequestIds.includes('P'));
    expect(a?.reasonCode).toBe('PLACED_PICKUP_FROM_CAR_AT_X');
    expect(a?.driverMemberId).toBe('adult');
    expect(a?.legs[0]?.role).toBe('passenger');
  });
  it('without a driver on board it stays a chauffeur/unmet, never this path', () => {
    const o = solve(baseInput({ cars: [makeCar('C1', { startLocationId: 'HAD' })], destinations, requests: [pickup({ canDrive: false })] }));
    const a = o.assignments.find((x) => x.servedRequestIds.includes('P'));
    expect(a?.reasonCode).not.toBe('PLACED_PICKUP_FROM_CAR_AT_X');
  });
  it('is not used when the car is elsewhere', () => {
    const o = solve(baseInput({ cars: [makeCar('C1')], destinations, requests: [pickup()] }));
    const a = o.assignments.find((x) => x.servedRequestIds.includes('P'));
    expect(a?.reasonCode).not.toBe('PLACED_PICKUP_FROM_CAR_AT_X');
  });
});

describe('105a: complementary explicit one-way legs are suggested onto one car (never automatic)', () => {
  const A = makeRequest({ id: 'A', memberId: 'mA', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'destA', departureMs: slotMs(36) });
  const B = (dep: number, extra: Parameters<typeof makeRequest>[0] = {}) =>
    makeRequest({ id: 'B', memberId: 'mB', tripType: 'one_way', tripShape: 'one_way_to', originId: 'destA', destinationId: 'home', departureMs: slotMs(dep), ...extra });

  it('offers a chainOneWay suggestion on the car that stays at X when B is a quarter hour too early', () => {
    const o = solve(baseInput({ cars: [makeCar('C1')], requests: [A, B(39)] }));
    const u = o.unmet.find((x) => x.requestId === 'B');
    expect(u).toBeDefined();
    const s = u?.suggestions.find((x) => x.kind === 'chainOneWay');
    expect(s).toMatchObject({ kind: 'chainOneWay', carId: 'C1', afterRequestId: 'A', shift: { departureMin: 15, returnMin: 0 } });
    // never applied by the solver itself: B stays unmet
    expect(o.assignments.some((a) => a.servedRequestIds.includes('B'))).toBe(false);
  });
  it('offers nothing when the shift would exceed the beyond-flex limit', () => {
    const o = solve(baseInput({ cars: [makeCar('C1')], requests: [A, B(30)] }));
    expect(o.unmet.find((x) => x.requestId === 'B')?.suggestions.some((x) => x.kind === 'chainOneWay') ?? false).toBe(false);
  });
});
