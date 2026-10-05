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

function a_(out: ReturnType<typeof solve>) {
  return out.assignments.filter((a) => a.servedRequestIds.includes('R1'));
}
