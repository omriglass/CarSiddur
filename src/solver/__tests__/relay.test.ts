import { describe, expect, it } from 'vitest';
import { pairRelays } from '../relay';
import { normalize } from '../slots';
import { baseInput, makeCar, makeRequest, slotMs } from '../__fixtures__/gen';

function outReq(id: string, destinationId: string, departureSlot: number, extra: Parameters<typeof makeRequest>[0] = {}) {
  return makeRequest({
    id,
    tripShape: 'one_way_to',
    oneWayCarMode: 'relay',
    destinationId,
    departureMs: slotMs(departureSlot),
    ...extra,
  });
}
function retReq(id: string, destinationId: string, returnSlot: number, extra: Parameters<typeof makeRequest>[0] = {}) {
  return makeRequest({
    id,
    tripShape: 'one_way_from',
    oneWayCarMode: 'relay',
    destinationId,
    returnMs: slotMs(returnSlot),
    ...extra,
  });
}

function normalizeAll(requests: ReturnType<typeof makeRequest>[]) {
  const cars = [makeCar('C1')];
  const input = baseInput({ cars, requests });
  const { normalized } = normalize(input);
  return { normalized, cars };
}

describe('pairRelays', () => {
  it('pairs an out 09:00 with a back 12:00 to the same destination on one car; both are served', () => {
    const { normalized, cars } = normalizeAll([outReq('O1', 'destA', 36), retReq('R1', 'destA', 48)]);
    const { pairs, unpaired } = pairRelays(normalized, cars);
    expect(pairs).toHaveLength(1);
    expect(unpaired).toHaveLength(0);
    expect(pairs[0]?.outRequestId).toBe('O1');
    expect(pairs[0]?.returnRequestId).toBe('R1');
    expect(pairs[0]?.shiftCost).toBe(0);
  });

  it('does not pair legs to the same zone but a different destination_id', () => {
    const { normalized, cars } = normalizeAll([
      outReq('O1', 'destA', 36),
      retReq('R1', 'destB', 48), // different destination even if same zone
    ]);
    const { pairs } = pairRelays(normalized, cars);
    expect(pairs).toHaveLength(0);
  });

  it('does not pair when the back-leg starts before the out-leg ends and neither can shift enough', () => {
    const { normalized, cars } = normalizeAll([
      outReq('O1', 'destA', 36), // ends at 36+travelSlots (destA travel 30min = 2 slots) => 38
      retReq('R1', 'destA', 37), // window [37-2,37) = [35,37) -> starts before out-leg ends, no flex
    ]);
    const { pairs, unpaired } = pairRelays(normalized, cars);
    expect(pairs).toHaveLength(0);
    expect(unpaired.map((u) => u.id).sort()).toEqual(['O1', 'R1']);
  });

  it('does not pair a back-leg scheduled on the next day (day-end rule)', () => {
    const { normalized, cars } = normalizeAll([
      outReq('O1', 'destA', 36), // day 0
      retReq('R1', 'destA', 96 + 48), // day 1
    ]);
    const { pairs } = pairRelays(normalized, cars);
    expect(pairs).toHaveLength(0);
  });

  it('shifts within flex to close a gap and pairs, ranked by (idleSlots + shiftCost)', () => {
    const { normalized, cars } = normalizeAll([
      outReq('O1', 'destA', 36, { flexDeparture: { earlierMin: 30, laterMin: 0 } }), // ends at 38, can move to start as early as 34 (end 36)
      retReq('R1', 'destA', 37, { flexReturn: { earlierMin: 0, laterMin: 30 } }), // window [35,37), can move return later up to 39 -> window [37,39)
    ]);
    const { pairs } = pairRelays(normalized, cars);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.shiftCost).toBeGreaterThan(0);
    expect(pairs[0]?.outWindow.end).toBeLessThanOrEqual(pairs[0]!.returnWindow.start);
  });

  it('ranks a pair by the higher of its two requests scores elsewhere (greedy.ts), but pairing itself ignores scores', () => {
    const { normalized, cars } = normalizeAll([
      outReq('O1', 'destA', 36, { submittedAtMs: 999 }),
      retReq('R1', 'destA', 48, { submittedAtMs: 1 }),
    ]);
    const { pairs } = pairRelays(normalized, cars);
    expect(pairs).toHaveLength(1); // submittedAtMs never enters the pairing decision
  });
});
