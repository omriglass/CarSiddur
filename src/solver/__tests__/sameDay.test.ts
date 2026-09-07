import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { normalize } from '../slots';
import { bestPlacementWithinFlex } from '../flexibility';
import { CarTimeline } from '../timeline';
import { runImprove } from '../improve';
import { baseInput, makeCar, makeRequest, slotMs } from '../__fixtures__/gen';
import type { PlacedSingle, Unit } from '../greedy';

describe('same-day scheduling', () => {
  it('does not compress a valid late ride past midnight to fit another request', () => {
    const car = makeCar('C1');
    const input = baseInput({ cars: [car], requests: [
      makeRequest({ id: 'late', departureMs: slotMs(63), returnMs: slotMs(95),
        flexDeparture: { earlierMin: 0, laterMin: 60 }, flexReturn: { earlierMin: 0, laterMin: 120 } }),
      makeRequest({ id: 'early', departureMs: slotMs(50), returnMs: slotMs(66) }),
    ] });
    const normalized = normalize(input).normalized;
    const late = normalized.find((r) => r.id === 'late')!;
    const early = normalized.find((r) => r.id === 'early')!;
    const timeline = new CarTimeline(car, 2, 7 * 96, 'home');
    timeline.add({ rideId: 'ride:late', window: late.window, startLocationId: 'home', endLocationId: 'home', overnightAck: false });
    const placed: PlacedSingle = { kind: 'single', nr: late, carId: car.id, window: late.window, shift: { departureMin: 0, returnMin: 0 } };
    const unit: Unit = { kind: 'single', id: early.id, score: 2, submittedAtMs: 0, single: early };
    const result = runImprove([unit], [placed], new Map([[car.id, timeline]]), input, new Map());
    expect(result.newlyPlaced).toHaveLength(0);
    expect(placed.window.end).toBe(95);
    expect(late.flexRet[1]).toBe(95);
  });

  it('keeps beyond-flex relay suggestions inside the request day', () => {
    const car = makeCar('C1');
    const input = baseInput({ cars: [car], requests: [makeRequest({ id: 'late', tripShape: 'one_way_to', oneWayCarMode: 'relay',
      departureMs: slotMs(94), returnMs: undefined, flexDeparture: { earlierMin: 0, laterMin: 120 } })] });
    const nr = normalize(input).normalized[0]!;
    const timeline = new CarTimeline(car, 0, 7 * 96, 'home');
    timeline.add({ rideId: 'busy', window: { start: 0, end: 94 }, startLocationId: 'home', endLocationId: 'home', overnightAck: false });
    expect(bestPlacementWithinFlex(timeline, nr, { widenMinutes: 120 })).toBeNull();
  });

  it('leaves legacy overnight requests unmet instead of producing a rejected board', () => {
    const output = solve(baseInput({ cars: [makeCar('C1')], requests: [makeRequest({ id: 'overnight', departureMs: slotMs(90), returnMs: slotMs(98) })] }));
    expect(output.assignments).toHaveLength(0);
    expect(output.unmet.map((r) => r.requestId)).toContain('overnight');
  });

  it('keeps a 23:59 return on its original day, including arrival-only requests', () => {
    const input = baseInput({ cars: [makeCar('C1')], requests: [
      makeRequest({ id: 'round', departureMs: slotMs(88), returnMs: slotMs(96) - 60_000 }),
      makeRequest({ id: 'return', tripShape: 'one_way_from', oneWayCarMode: 'passenger', departureMs: undefined, returnMs: slotMs(96) - 60_000 }),
    ] });
    const requests = normalize(input).normalized;
    expect(requests.map((request) => request.dayIndex)).toEqual([0, 0]);
    expect(requests.find((r) => r.id === 'round')?.dayWindow.end).toBe(96);
    expect(solve(input).assignments.find((a) => a.driverRequestId === 'round')?.window.end).toBe(96);
  });
});
