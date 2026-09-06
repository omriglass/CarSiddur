import { describe, expect, it } from 'vitest';
import { CarTimeline } from '../timeline';
import { makeCar } from '../__fixtures__/gen';

const HOME = 'home';
const WEEK_SLOTS = 96 * 7;

function bufferedTl(bufferSlots: number) {
  return new CarTimeline(makeCar('C1'), bufferSlots, WEEK_SLOTS, HOME);
}

describe('CarTimeline', () => {
  it('a ride ending exactly at the next start fails with buffer 30, passes with buffer 0', () => {
    const withBuffer = bufferedTl(2); // 30 min
    withBuffer.add({ rideId: 'a', window: { start: 0, end: 10 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    expect(withBuffer.isFree({ start: 10, end: 20 }, HOME)).toBe(false);
    expect(withBuffer.isFree({ start: 12, end: 20 }, HOME)).toBe(true);

    const noBuffer = bufferedTl(0);
    noBuffer.add({ rideId: 'a', window: { start: 0, end: 10 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    expect(noBuffer.isFree({ start: 10, end: 20 }, HOME)).toBe(true);
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
});
