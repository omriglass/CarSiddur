// FC1 (REQ item 231): runFreedSlot — the one ranking the edge function and the browser preview share. The fixture is a
// real `freed_slot_rank_input()` answer (a ride shortened from 16:00 to 13:00, one waiting request 14:00–16:00), with
// the names made neutral.
import { describe, expect, it } from 'vitest';

import raw from '../__fixtures__/freedSlotRaw.json';
import { freedSlotInputFrom, freedWeekDays, runFreedSlot, type FreedSlotRaw, type FreedSlotRawCandidate } from '../freedSlotRun';

const base = raw as unknown as FreedSlotRaw;
const clone = (): FreedSlotRaw => JSON.parse(JSON.stringify(base)) as FreedSlotRaw;
const first = base.candidates[0]!;
const HOUR = 3_600_000;
function candidate(id: string, name: string, extra: Partial<FreedSlotRawCandidate> = {}): FreedSlotRawCandidate {
  return { ...first, id, name, memberId: `member-${id}`, ...extra };
}

describe('freedWeekDays', () => {
  it('builds seven 96-slot days with the day end inside each day', () => {
    const days = freedWeekDays('23:59:00');
    expect(days).toHaveLength(7);
    expect(days[1]).toEqual({ dayIndex: 1, startSlot: 96, endSlot: 192, dayEndSlot: 191 });
  });
});

describe('freedSlotInputFrom', () => {
  it('maps the SQL answer onto the matchFreedSlot input', () => {
    const built = freedSlotInputFrom(base)!;
    expect(built.input.car.id).toBe(base.offer.carId);
    expect(built.input.candidates.map((r) => r.id)).toEqual([first.id]);
    expect(built.freedWindow.end).toBeGreaterThan(built.freedWindow.start);
    expect(built.bufferSlots).toBe(2);
    // the shortened ride is still on the car (it holds the rest of its time)
    expect(base.otherRides.length).toBe(1);
  });

  it('is null without a car or an active policy', () => {
    expect(freedSlotInputFrom({ ...clone(), policy: null })).toBeNull();
    expect(freedSlotInputFrom({ ...clone(), car: null })).toBeNull();
  });
});

describe('runFreedSlot', () => {
  it('one waiting request gets the car', () => {
    const result = runFreedSlot(base);
    expect(result.outcome).toEqual({ kind: 'auto', requestId: first.id, name: first.name });
    expect(result.ranked.map((c) => c.requestId)).toEqual([first.id]);
    expect(result.ranked[0]!.requesterId).toBe(first.memberId);
    expect(result.options[0]).toMatchObject({ request_ids: [first.id], recommended: true });
  });

  it('several candidates: the Sadran decides, every name listed', () => {
    const input = clone();
    input.candidates.push(candidate('second', 'Member Two', { departureMs: first.departureMs! + HOUR, returnMs: first.returnMs! + HOUR }));
    const result = runFreedSlot(input);
    expect(result.outcome.kind).toBe('sadran');
    expect(result.outcome.kind === 'sadran' && [...result.outcome.names].sort()).toEqual(['Member 103', 'Member Two']);
  });

  it('a lone plan-B candidate goes to the Sadran too', () => {
    const input = clone();
    input.candidates[0] = { ...input.candidates[0]!, planB: true };
    expect(runFreedSlot(input).outcome).toEqual({ kind: 'sadran', requestIds: [first.id], names: [first.name] });
  });

  it('an open contested group whose member can take it discusses it', () => {
    const input = clone();
    input.group = { id: 'g1', members: [{ requestId: first.id, name: first.name }, { requestId: 'other', name: 'Member Three' }] };
    expect(runFreedSlot(input).outcome).toEqual({ kind: 'group', requestIds: [first.id, 'other'], names: [first.name, 'Member Three'] });
  });

  it('an offer already held for a group ranks nothing', () => {
    const input = clone();
    input.offer.groupId = 'g1';
    expect(runFreedSlot(input)).toEqual({ ranked: [], options: [], outcome: { kind: 'held' } });
  });

  it('nobody waiting, or nobody who fits the freed hours', () => {
    expect(runFreedSlot({ ...clone(), candidates: [] }).outcome).toEqual({ kind: 'none' });
    const input = clone();
    // wants 08:00-10:00, before the freed hours
    input.candidates[0] = { ...input.candidates[0]!, departureMs: first.departureMs! - 6 * HOUR, returnMs: first.returnMs! - 6 * HOUR };
    expect(runFreedSlot(input).outcome).toEqual({ kind: 'none' });
  });
});
