import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { baseInput, makeCar, makeDestinations, makeRequest, slotMs } from '../__fixtures__/gen';

// slot 0 = Sunday 00:00 (15-min slots): 07:15 = 29, 08:00 = 32, 08:45 = 35, 10:00 = 40, 12:00 = 48
const destinations = {
  ...makeDestinations(),
  HAIFA: { id: 'HAIFA', zone: 'zoneHaifa', distanceKm: 12, travelMinutes: 20 },
  AFULA: { id: 'AFULA', zone: 'zoneAfula', distanceKm: 30, travelMinutes: 35 },
};
const travel = [{ fromId: 'HAIFA', toId: 'AFULA', distanceKm: 30, travelMinutes: 30 }];
const served = (o: ReturnType<typeof solve>): string[] => o.assignments.flatMap((a) => a.servedRequestIds).sort();

const boost = (value: number) => (value > 0 ? { value, reason: 'test' } : undefined);

function twoRequests(bDepSlot: number, boostA: number, boostB: number) {
  const A = makeRequest({ id: 'A', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'HAIFA', departureMs: slotMs(29), manualBoost: boost(boostA) });
  const B = makeRequest({ id: 'B', originId: 'HAIFA', destinationId: 'AFULA', departureMs: slotMs(bDepSlot), returnMs: slotMs(48), manualBoost: boost(boostB) });
  return baseInput({ cars: [makeCar('C1')], destinations, travel, requests: [A, B] });
}

describe('retry passes: a car moved by a one-way leg unlocks requests at the new place', () => {
  it.each([
    ['B higher priority', 0, 5],
    ['A higher priority', 5, 0],
  ])('B from Haifa 1 h after A arrives is placed (%s)', (_l, boostA, boostB) => {
    const out = solve(twoRequests(35, boostA, boostB));
    expect(served(out)).toEqual(['A', 'B']);
    expect(out.unmet).toEqual([]);
    expect(out.unmet.flatMap((u) => u.suggestions)).toEqual([]);
  });

  it('B only 15 min after A arrives stays unmet (30-min turnaround) and gets no 0-minute shift', () => {
    const out = solve(twoRequests(32, 0, 0));
    expect(served(out)).toEqual(['A']);
    expect(out.unmet.map((u) => u.requestId)).toEqual(['B']);
    for (const s of out.unmet.flatMap((u) => u.suggestions)) {
      if (s.kind === 'shiftBeyondFlex') expect(s.shift.departureMin === 0 && s.shift.returnMin === 0).toBe(false);
    }
  });

  it('chain of three: home -> Haifa, Haifa -> Afula (one-way), then an Afula round trip', () => {
    const r1 = makeRequest({ id: 'R1', tripType: 'one_way', tripShape: 'one_way_to', destinationId: 'HAIFA', departureMs: slotMs(29) });
    const r2 = makeRequest({ id: 'R2', tripType: 'one_way', tripShape: 'one_way_to', originId: 'HAIFA', destinationId: 'AFULA', departureMs: slotMs(35) });
    const r3 = makeRequest({ id: 'R3', originId: 'AFULA', destinationId: 'HAIFA', departureMs: slotMs(42), returnMs: slotMs(52), manualBoost: boost(9) });
    const input = baseInput({ cars: [makeCar('C1')], destinations, travel: [...travel, { fromId: 'AFULA', toId: 'HAIFA', distanceKm: 30, travelMinutes: 30 }], requests: [r1, r2, r3] });
    const out = solve(input);
    expect(served(out)).toEqual(['R1', 'R2', 'R3']);
    expect(out.unmet).toEqual([]);
  });

  it('is deterministic', () => {
    const input = twoRequests(35, 0, 5);
    expect(solve(input)).toEqual(solve(input));
  });
});
