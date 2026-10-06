import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { pairRelays } from '../relay';
import { normalize } from '../slots';
import { baseInput, makeCar, makeDestinations, makeRequest, passengers, slotMs } from '../__fixtures__/gen';

// REQ §13.104 (QA run 4): a, b, c, R4B7.
const out = (id: string, dep: number, extra: Parameters<typeof makeRequest>[0] = {}) =>
  makeRequest({ id, tripShape: 'one_way_to', oneWayCarMode: 'relay', departureMs: slotMs(dep), ...extra });
const ret = (id: string, r: number, extra: Parameters<typeof makeRequest>[0] = {}) =>
  makeRequest({ id, tripShape: 'one_way_from', oneWayCarMode: 'relay', returnMs: slotMs(r), ...extra });

describe('104a: cross-request relay pairs only when the wait is not needed elsewhere', () => {
  it('pairs when nobody else overlaps the wait, does not when a request needs the only car', () => {
    const cars = [makeCar('C1')];
    const pair = [out('O1', 36), ret('R1', 48)];
    const free = normalize(baseInput({ cars, requests: pair })).normalized;
    expect(pairRelays(free, cars).pairs).toHaveLength(1);
    const busy = normalize(baseInput({ cars, requests: [...pair, makeRequest({ id: 'RT', destinationId: 'destB', departureMs: slotMs(40), returnMs: slotMs(44) })] })).normalized;
    expect(pairRelays(busy.filter((n) => n.id !== 'RT'), cars, busy.filter((n) => n.id === 'RT')).pairs).toHaveLength(0);
  });
});

describe('104b: a short drop-off + pickup is one chauffeur ride', () => {
  const dropOff = (id: string, extra = {}) =>
    makeRequest({ id, canDrive: false, tripType: 'drop_off', tripShape: 'round_trip', needsCarAtDestination: false, departureMs: slotMs(36), returnMs: slotMs(40), ...extra });
  it('serves both legs on a single ride when the wait is short and the car is not needed', () => {
    const o = solve(baseInput({ cars: [makeCar('C1')], requests: [dropOff('D')] }));
    expect(o.unmet).toEqual([]);
    const rides = o.assignments.filter((a) => a.servedRequestIds.includes('D'));
    expect(rides).toHaveLength(1);
    expect(rides[0]?.legs.map((l) => l.leg).sort()).toEqual(['out', 'return']);
  });
  it('keeps two rides when the wait is long', () => {
    const o = solve(baseInput({ cars: [makeCar('C1')], requests: [dropOff('D', { returnMs: slotMs(60) })] }));
    expect(o.assignments.filter((a) => a.servedRequestIds.includes('D')).length).toBe(2);
  });
});

describe('104c: child seats go to children', () => {
  it('a lone adult does not take the child-seat car while a kid request overlaps', () => {
    const cars = [makeCar('A-kids', { seatConfigs: [passengers(4, 2, 0)] }), makeCar('B-plain')];
    const adult = makeRequest({ id: 'ADULT', destinationId: 'destB', departureMs: slotMs(36), returnMs: slotMs(48) });
    const kid = makeRequest({ id: 'KID', destinationId: 'destB', departureMs: slotMs(36), returnMs: slotMs(48), passengers: passengers(1, 1) });
    const o = solve(baseInput({ cars, requests: [adult, kid] }));
    expect(o.unmet).toEqual([]);
    expect(o.assignments.find((a) => a.servedRequestIds.includes('ADULT'))?.carId).toBe('B-plain');
    expect(o.assignments.find((a) => a.servedRequestIds.includes('KID'))?.carId).toBe('A-kids');
  });
  it('a kid leg blocked by seats reports a seats reason, not no-relay-partner', () => {
    const cars = [makeCar('A-kids', { seatConfigs: [passengers(4, 2, 0)] })];
    const block = makeRequest({ id: 'BLOCK', destinationId: 'destB', departureMs: slotMs(34), returnMs: slotMs(48), passengers: passengers(2, 2) });
    const kid = makeRequest({ id: 'KIDLEG', tripShape: 'one_way_to', oneWayCarMode: 'relay', destinationId: 'destB', departureMs: slotMs(36), passengers: passengers(1, 1), manualBoost: undefined });
    const o = solve(baseInput({ cars, requests: [block, kid] }));
    const u = o.unmet.find((x) => x.requestId === 'KIDLEG');
    expect(u?.reasonCode).toBe('UNMET_NO_CAR_SEATS_BUSY');
  });
});

describe('R4B7: a chauffeur ride from a car parked away includes the empty drive', () => {
  it('starts earlier by the drive from where the car is to the pickup origin', () => {
    const destinations = { ...makeDestinations(), HAD: { id: 'HAD', zone: 'zH', distanceKm: 30, travelMinutes: 30 }, HAI: { id: 'HAI', zone: 'zHai', distanceKm: 60, travelMinutes: 60 } };
    const cars = [makeCar('C1', { startLocationId: 'HAD' })];
    const r = makeRequest({ id: 'P', canDrive: false, tripType: 'drop_off', tripShape: 'one_way_to', needsCarAtDestination: false, originId: 'HAI', destinationId: 'destA', departureMs: slotMs(40) });
    const o = solve(baseInput({ cars, destinations, requests: [r] }));
    const a = o.assignments.find((x) => x.servedRequestIds.includes('P'));
    expect(a).toBeDefined();
    expect(a?.originId).toBe('HAD');
    expect(a?.destinationId).toBe('HAD');
    expect(a?.window.start).toBeLessThan(40);
  });
});
