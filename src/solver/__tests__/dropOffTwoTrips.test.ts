// A drop-off with a pickup is two separate trips (REQUIREMENTS §13.94,
// docs/SOLVER.md §1.3a): never a `keep` block holding the car for the window.
import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { baseInput, makeCar, makeRequest, slotMs } from '../__fixtures__/gen';

const dropOff = (id: string, extra = {}) =>
  makeRequest({
    id,
    memberId: `m-${id}`,
    destinationId: 'destA',
    needsCarAtDestination: false,
    departureMs: slotMs(36), // 09:00
    returnMs: slotMs(56), // 14:00
    ...extra,
  });

describe('drop-off with a pickup (REQ §13.94)', () => {
  it('is never placed as a keep block, even for a requester who can drive', () => {
    const out = solve(baseInput({ cars: [makeCar('C1')], requests: [dropOff('R1')] }));
    expect(out.assignments.length).toBeGreaterThan(0);
    for (const a of a_(out)) {
      expect(a.legs.every((l) => l.carMode !== 'keep' && l.leg !== 'both')).toBe(true);
    }
    // the request is served by its own id, once per leg at most
    expect(out.assignments.every((x) => x.servedRequestIds.every((id) => id === 'R1'))).toBe(true);
  });

  it('leaves the car free between the drop-off and the pickup for a third request', () => {
    const third = makeRequest({
      id: 'R2',
      memberId: 'm-R2',
      originId: 'destA', // the car waits at destA between the two trips
      destinationId: 'destB',
      departureMs: slotMs(44), // 11:00 - 12:00, inside the old keep window
      returnMs: slotMs(48),
    });
    const out = solve(baseInput({ cars: [makeCar('C1')], requests: [dropOff('R1'), third] }));
    expect(out.unmet.map((u) => u.requestId)).toEqual([]);
    const r2 = out.assignments.find((a) => a.servedRequestIds.includes('R2'));
    expect(r2?.carId).toBe('C1');
    expect(r2?.window.start).toBe(44);
  });

  it('is unmet with the existing codes when neither leg can be served', () => {
    const blocker = makeRequest({
      id: 'B1',
      memberId: 'm-B1',
      destinationId: 'destB',
      departureMs: slotMs(0),
      returnMs: slotMs(95),
    });
    const out = solve(baseInput({ cars: [makeCar('C1')], requests: [blocker, dropOff('R1')] }));
    const u = out.unmet.find((x) => x.requestId === 'R1');
    expect(u).toBeDefined();
    expect(['UNMET_NO_RELAY_PARTNER', 'UNMET_NO_CAR_AT_ORIGIN', 'UNMET_NO_CAR', 'UNMET_NEEDS_DRIVER', 'UNMET_PASSENGER_NO_HOST']).toContain(u?.reasonCode);
    expect(out.assignments.some((a) => a.servedRequestIds.includes('R1'))).toBe(false);
  });
});

describe('a הקפצה\'s two legs connect on one car (REQ §13.95 H2)', () => {
  const byRide = (out: ReturnType<typeof solve>, id: string) => out.assignments.filter((a) => a.servedRequestIds.includes(id));

  it('the requester drives both legs on one car, preferred over pairing with another member\'s leg', () => {
    const lone = makeRequest({ id: 'R3', memberId: 'm-R3', destinationId: 'destA', tripShape: 'one_way_from', needsCarAtDestination: false, returnMs: slotMs(48) });
    const out = solve(baseInput({ cars: [makeCar('C1'), makeCar('C2')], requests: [dropOff('R1'), lone] }));
    const legs = byRide(out, 'R1');
    expect(legs).toHaveLength(2);
    expect(new Set(legs.map((a) => a.carId)).size).toBe(1);
    expect(legs.every((a) => a.driverRequestId === 'R1' && a.legs[0]?.carMode === 'relay')).toBe(true);
    // the other member's lone leg is not the one that loses its volunteer-free pair partner to R1
    expect(byRide(out, 'R3')[0]?.reasonCode).toBe('PLACED_CHAUFFEUR_NO_RETURNER');
  });

  it('a non-driver keeps the chauffeur path (no connected pair)', () => {
    const out = solve(baseInput({ cars: [makeCar('C1')], requests: [dropOff('R1', { canDrive: false })] }));
    const legs = byRide(out, 'R1');
    expect(legs.every((a) => a.legs[0]?.carMode === 'chauffeur')).toBe(true);
  });

  it('falls back to chauffeur rides when no car can wait at the destination between the legs', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      fixedRides: [
        {
          id: 'FX1', carId: 'C1', window: { start: 44, end: 48 }, originId: 'home', destinationId: 'home',
          driverRequestId: 'FXR', driverMemberId: 'owner',
          legs: [{ requestId: 'FXR', leg: 'both', carMode: 'keep', originId: 'home', destinationId: 'destB', role: 'driver' }],
          servedRequestIds: ['FXR'], passengers: { adults: 1, childSeats: 0, boosters: 0 }, luggageCount: 0, overnightAck: false, kind: 'pinned',
        },
      ],
      requests: [dropOff('R1')],
    });
    const out = solve(input);
    const legs = byRide(out, 'R1');
    expect(out.unmet.map((u) => u.requestId)).toEqual([]);
    expect(legs).toHaveLength(2);
    expect(legs.every((a) => a.legs[0]?.carMode === 'chauffeur')).toBe(true);
  });
});

function a_(out: ReturnType<typeof solve>) {
  return out.assignments.filter((a) => a.servedRequestIds.includes('R1'));
}
