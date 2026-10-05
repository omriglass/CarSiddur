import { describe, expect, it } from 'vitest';
import { CarTimeline } from '../timeline';
import { makeCar } from '../__fixtures__/gen';

const HOME = 'home';
const WEEK_SLOTS = 96 * 7;

function bufferedTl(bufferSlots: number) {
  return new CarTimeline(makeCar('C1'), bufferSlots, WEEK_SLOTS, HOME);
}

describe('CarTimeline', () => {
  it('honors an approved gap only between existing fixed bookings, in either insertion order', () => {
    const first = { rideId: 'a', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false, approvedBufferAfterSlots: 0 };
    const next = { rideId: 'b', window: { start: 20, end: 30 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false };
    for (const blocks of [[first, next], [next, first]]) {
      const tl = bufferedTl(2);
      for (const block of blocks) tl.forceAdd(block);
      expect(tl.allBlocks()).toHaveLength(2);
      expect(() => tl.forceAdd({ ...next, rideId: 'overlap', window: { start: 19, end: 22 } })).toThrow();
    }
    const tl = bufferedTl(2);
    tl.forceAdd(first);
    expect(tl.isFree(next.window, HOME)).toBe(false);
    expect(() => tl.add(next)).toThrow();
    expect(tl.isFree({ start: 22, end: 30 }, HOME)).toBe(true);
  });
  it('a ride ending exactly at the next start fails with buffer 30, passes with buffer 0', () => {
    const withBuffer = bufferedTl(2); // 30 min
    withBuffer.add({ rideId: 'a', window: { start: 0, end: 10 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    expect(withBuffer.isFree({ start: 10, end: 20 }, HOME)).toBe(false);
    expect(withBuffer.isFree({ start: 12, end: 20 }, HOME)).toBe(true);

    const noBuffer = bufferedTl(0);
    noBuffer.add({ rideId: 'a', window: { start: 0, end: 10 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    expect(noBuffer.isFree({ start: 10, end: 20 }, HOME)).toBe(true);
  });

  it('the two legs of one relay pair need no buffer between them, but still may not overlap (REQ §13.88, owner 2026-09-24)', () => {
    const tl = bufferedTl(2); // 30 min
    tl.add({ rideId: 'out', window: { start: 0, end: 10 }, startLocationId: HOME, endLocationId: 'X', overnightAck: false, relayPairId: 'p1' });
    // Same pair: back-to-back at X is fine, an overlap is not.
    expect(tl.isFree({ start: 10, end: 20 }, 'X', 'p1')).toBe(true);
    expect(tl.isFree({ start: 9, end: 20 }, 'X', 'p1')).toBe(false);
    // Anything else (another pair, or no pair) keeps the full buffer.
    expect(tl.isFree({ start: 10, end: 20 }, 'X', 'p2')).toBe(false);
    expect(tl.isFree({ start: 10, end: 20 }, 'X')).toBe(false);
    tl.add({ rideId: 'ret', window: { start: 10, end: 20 }, startLocationId: 'X', endLocationId: HOME, overnightAck: false, relayPairId: 'p1' });
    // After the pair, the next ride still needs the buffer.
    expect(tl.isFree({ start: 20, end: 30 }, HOME)).toBe(false);
    expect(tl.isFree({ start: 22, end: 30 }, HOME)).toBe(true);
  });

  it('a ride abutting maintenance needs the buffer too', () => {
    const car = makeCar('C1', { maintenance: [{ start: 10, end: 20 }] });
    const tl = new CarTimeline(car, 2, WEEK_SLOTS, HOME);
    expect(tl.isFree({ start: 20, end: 30 }, HOME)).toBe(false);
    expect(tl.isFree({ start: 22, end: 30 }, HOME)).toBe(true);
    expect(tl.isFree({ start: 0, end: 9 }, HOME)).toBe(false); // 9+2=11 > 10: too close
    expect(tl.isFree({ start: 0, end: 8 }, HOME)).toBe(true); // 8+2=10 <= 10: exactly the buffer
  });

  it('reports gaps at week start and week end', () => {
    const tl = bufferedTl(2);
    tl.add({ rideId: 'a', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    const gaps = tl.gaps();
    expect(gaps[0]).toEqual({ window: { start: 0, end: 8 }, locationId: HOME });
    expect(gaps.at(-1)).toEqual({ window: { start: 22, end: WEEK_SLOTS }, locationId: HOME });
  });

  it('remove then re-add works and frees the slot again', () => {
    const tl = bufferedTl(2);
    tl.add({ rideId: 'a', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    expect(tl.isFree({ start: 10, end: 20 }, HOME)).toBe(false);
    tl.remove('a');
    expect(tl.isFree({ start: 10, end: 20 }, HOME)).toBe(true);
    tl.add({ rideId: 'a', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    expect(tl.has('a')).toBe(true);
  });

  describe('location', () => {
    it('after a relay-out block, locationAt is the destination; home is unavailable and dest is available during the away gap', () => {
      const tl = bufferedTl(2);
      tl.add({ rideId: 'out', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: 'BIN', overnightAck: false });
      expect(tl.locationAt(25)).toBe('BIN');
      expect(tl.isFree({ start: 25, end: 30 }, HOME)).toBe(false);
      expect(tl.isFree({ start: 25, end: 30 }, 'BIN')).toBe(true);
      expect(tl.awayAt(25)).toBe(true);
    });

    it('add rejects a block whose start location mismatches the car location', () => {
      const tl = bufferedTl(2);
      tl.add({ rideId: 'out', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: 'BIN', overnightAck: false });
      expect(() =>
        tl.add({ rideId: 'wrong', window: { start: 25, end: 30 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false }),
      ).toThrow();
    });

    it('awayWindows() reports the full raw away gap, not the buffer-trimmed one', () => {
      const tl = bufferedTl(2);
      tl.add({ rideId: 'out', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: 'BIN', overnightAck: false });
      tl.add({ rideId: 'back', window: { start: 30, end: 40 }, startLocationId: 'BIN', endLocationId: HOME, overnightAck: false });
      expect(tl.awayWindows()).toEqual([{ locationId: 'BIN', window: { start: 20, end: 30 } }]);
    });
  });

  describe('day end', () => {
    it('flags an away window spanning dayEndSlot without an acknowledged overnight ride', () => {
      const tl = bufferedTl(2);
      tl.add({ rideId: 'out', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: 'BIN', overnightAck: false });
      const days = [{ dayIndex: 0 as const, startSlot: 0, endSlot: 96, dayEndSlot: 25 }];
      // no later obstacle removes the car from BIN, so the raw away window runs to the end of the timeline
      expect(tl.dayEndViolations(days)).toEqual([{ window: { start: 20, end: WEEK_SLOTS }, causeRideId: 'out' }]);
    });

    it('does not flag when the causing block is an acknowledged overnight ride', () => {
      const tl = bufferedTl(2);
      tl.add({ rideId: 'out', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: 'BIN', overnightAck: true });
      const days = [{ dayIndex: 0 as const, startSlot: 0, endSlot: 96, dayEndSlot: 25 }];
      expect(tl.dayEndViolations(days)).toEqual([]);
    });
  });

  describe('isFree end-check (REQUIREMENTS §13.93)', () => {
    it('rejects a candidate that would leave the car away from an already-scheduled later block', () => {
      const tl = bufferedTl(2);
      // A later block already expects the car at HOME when it starts.
      tl.add({ rideId: 'later', window: { start: 40, end: 50 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
      // A one-way candidate [10,20) HOME -> X would strand that later block.
      expect(tl.isFree({ start: 10, end: 20 }, HOME, undefined, 'X')).toBe(false);
      // Without the endLocationId check it would have been free (no overlap).
      expect(tl.isFree({ start: 10, end: 20 }, HOME)).toBe(true);
    });

    it('accepts a one-way candidate when the next block already starts at the same place it is left', () => {
      const tl = bufferedTl(2);
      tl.forceAdd({ rideId: 'later', window: { start: 40, end: 50 }, startLocationId: 'X', endLocationId: 'X', overnightAck: false });
      expect(tl.isFree({ start: 10, end: 20 }, HOME, undefined, 'X')).toBe(true);
    });

    it('accepts a one-way candidate with no later block at all', () => {
      const tl = bufferedTl(2);
      expect(tl.isFree({ start: 10, end: 20 }, HOME, undefined, 'X')).toBe(true);
    });

    it('is a no-op when endLocationId equals originId (keep/chauffeur legs)', () => {
      const tl = bufferedTl(2);
      tl.forceAdd({ rideId: 'later', window: { start: 40, end: 50 }, startLocationId: 'X', endLocationId: 'X', overnightAck: false });
      expect(tl.isFree({ start: 10, end: 20 }, HOME, undefined, HOME)).toBe(true);
    });
  });

  describe('chainBreaks() and weekEndAway() (REQUIREMENTS §13.93)', () => {
    it('forceAdd records a chain break instead of throwing when a fixed ride starts where the car is not', () => {
      const tl = bufferedTl(2);
      tl.add({ rideId: 'out', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: 'X', overnightAck: false });
      // The car is at X after `out`, but this fixed ride claims to start at HOME.
      tl.forceAdd({ rideId: 'fixed1', window: { start: 40, end: 50 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
      expect(tl.chainBreaks()).toEqual([{ rideId: 'fixed1', carLocationId: 'X', rideOriginId: HOME }]);
    });

    it('chainBreaks() is empty when every fixed ride chains correctly', () => {
      const tl = bufferedTl(2);
      tl.add({ rideId: 'out', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: 'X', overnightAck: false });
      tl.forceAdd({ rideId: 'fixed1', window: { start: 40, end: 50 }, startLocationId: 'X', endLocationId: 'X', overnightAck: false });
      expect(tl.chainBreaks()).toEqual([]);
    });

    it('weekEndAway() reports the car away from its base at the end of the week', () => {
      const tl = new CarTimeline(makeCar('C1', { baseLocationId: HOME }), 2, WEEK_SLOTS, HOME);
      tl.add({ rideId: 'out', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: 'X', overnightAck: false });
      expect(tl.weekEndAway()).toEqual({ locationId: 'X' });
    });

    it('weekEndAway() is null when the car ends the week at its base (home default)', () => {
      const tl = bufferedTl(2);
      tl.add({ rideId: 'out', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: 'X', overnightAck: false });
      tl.add({ rideId: 'back', window: { start: 40, end: 50 }, startLocationId: 'X', endLocationId: HOME, overnightAck: false });
      expect(tl.weekEndAway()).toBeNull();
    });

    it('weekEndAway() honors a non-home base location: a car based in Haifa that never left the department home is "away" from its own base', () => {
      const tl = new CarTimeline(makeCar('C1', { baseLocationId: 'HAIFA' }), 2, WEEK_SLOTS, HOME);
      expect(tl.weekEndAway()).toEqual({ locationId: HOME });
    });

    it('weekEndAway() is null for a Haifa-based car that starts and ends the week in Haifa', () => {
      const tl = new CarTimeline(makeCar('C1', { baseLocationId: 'HAIFA', startLocationId: 'HAIFA' }), 2, WEEK_SLOTS, HOME);
      expect(tl.weekEndAway()).toBeNull();
    });
  });
  describe('location-neutral reservations (REQUIREMENTS §13.96)', () => {
    const neutral = { rideId: 'res', window: { start: 30, end: 40 }, startLocationId: 'HAIFA', endLocationId: 'HAIFA', overnightAck: false, locationNeutral: true };
    const real = (rideId: string, start: number, end: number, from = HOME, to = HOME) => ({ rideId, window: { start, end }, startLocationId: from, endLocationId: to, overnightAck: false });

    it('still occupies time and buffer, but the car stays where it was', () => {
      const tl = bufferedTl(2);
      tl.add(real('a', 10, 20));
      tl.forceAdd(neutral);
      expect(tl.locationAt(45)).toBe(HOME);
      expect(tl.isFree({ start: 35, end: 45 }, HOME)).toBe(false);
      expect(tl.isFree({ start: 41, end: 50 }, HOME)).toBe(false); // buffer after the reservation
      expect(tl.isFree({ start: 42, end: 50 }, HOME)).toBe(true);
      expect(tl.isFree({ start: 42, end: 50 }, 'HAIFA')).toBe(false);
    });

    it('never produces a chain break, nor causes one for the next real ride', () => {
      const tl = bufferedTl(2);
      tl.forceAdd(real('a', 10, 20));
      tl.forceAdd(neutral);
      tl.forceAdd(real('b', 50, 60));
      expect(tl.chainBreaks()).toEqual([]);
      tl.forceAdd(real('c', 70, 80, 'X', HOME));
      expect(tl.chainBreaks()).toEqual([{ rideId: 'c', carLocationId: HOME, rideOriginId: 'X' }]);
    });

    it('the isFree end-check skips a neutral next block', () => {
      const tl = bufferedTl(2);
      tl.forceAdd({ ...neutral, startLocationId: 'ELSEWHERE', endLocationId: 'ELSEWHERE' });
      expect(tl.isFree({ start: 5, end: 15 }, HOME, undefined, 'X')).toBe(true);
      tl.forceAdd(real('b', 60, 70, 'X', HOME));
      expect(tl.isFree({ start: 5, end: 15 }, HOME, undefined, 'X')).toBe(true);
      expect(tl.isFree({ start: 5, end: 15 }, HOME, undefined, 'Y')).toBe(false);
    });

    it('is ignored by weekEndAway() and awayWindows()', () => {
      const tl = bufferedTl(2);
      tl.forceAdd({ ...neutral, window: { start: 80, end: WEEK_SLOTS } });
      expect(tl.weekEndAway()).toBeNull();
      expect(tl.awayWindows()).toEqual([]);
    });
  });

  it('remove() + restore() puts a block back exactly, even when the chain changed meanwhile (rollback never throws)', () => {
    const tl = bufferedTl(0);
    const a = { rideId: 'a', window: { start: 10, end: 20 }, startLocationId: HOME, endLocationId: 'haifa', overnightAck: false };
    tl.add(a);
    const removedA = tl.remove('a');
    tl.add({ rideId: 'x', window: { start: 0, end: 5 }, startLocationId: HOME, endLocationId: 'gaza', overnightAck: false });
    // the car is now at gaza when a starts: add() refuses, restore() does not
    expect(() => tl.add(a)).toThrow(/starts at/);
    expect(() => tl.restore(removedA!)).not.toThrow();
    expect(tl.has('a')).toBe(true);
  });
});
