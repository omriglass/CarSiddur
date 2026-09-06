import { describe, expect, it } from 'vitest';
import { dayBoundsForSlot, formatSlotTime, isAligned, normalize, toSlotCeil, toSlotFloor } from '../slots';
import { baseInput, makeCar, makeDstSpringWeekDays, makeRequest, makeWeekDays, slotMs, WEEK_START_MS } from '../__fixtures__/gen';

describe('slots: grid arithmetic', () => {
  it('toSlotFloor/toSlotCeil round departure down and return up', () => {
    expect(toSlotFloor(WEEK_START_MS + 1000, WEEK_START_MS)).toBe(0);
    expect(toSlotCeil(WEEK_START_MS + 1000, WEEK_START_MS)).toBe(1);
  });

  it('isAligned detects 15-minute misalignment', () => {
    expect(isAligned(WEEK_START_MS + 15 * 60 * 1000, WEEK_START_MS)).toBe(true);
    expect(isAligned(WEEK_START_MS + 1000, WEEK_START_MS)).toBe(false);
  });

  it('formatSlotTime is pure arithmetic off the day start, no Date object', () => {
    const day = { dayIndex: 0 as const, startSlot: 96, endSlot: 192, dayEndSlot: 191 };
    expect(formatSlotTime(96 + 32, day)).toBe('08:00'); // 32 slots = 8h
    expect(formatSlotTime(96 + 34, day)).toBe('08:30');
  });

  it('dayBoundsForSlot finds the containing day', () => {
    const days = makeWeekDays();
    const day = dayBoundsForSlot(days, 96 + 10);
    expect(day.dayIndex).toBe(1);
  });
});

describe('normalize()', () => {
  it('flags a misaligned request without throwing', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', departureMs: WEEK_START_MS + 32 * 15 * 60 * 1000 + 1000, returnMs: slotMs(48) })],
    });
    const { warnings, normalized } = normalize(input);
    expect(warnings.some((w) => w.code === 'TIME_NOT_ALIGNED')).toBe(true);
    expect(normalized).toHaveLength(1); // still normalized, never throws
  });

  it('flags a passenger set that fits no active car', () => {
    const input = baseInput({
      cars: [makeCar('C1', { seatConfigs: [{ adults: 2, childSeats: 0, boosters: 0 }] })],
      requests: [
        makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48), passengers: { adults: 5, childSeats: 0, boosters: 0 } }),
      ],
    });
    const { warnings } = normalize(input);
    expect(warnings.some((w) => w.code === 'NO_CAR_FITS_SEATS')).toBe(true);
  });

  it('defaults a missing one-way car mode to passenger with a warning', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', tripShape: 'one_way_to', departureMs: slotMs(32) })],
    });
    const { warnings, normalized } = normalize(input);
    expect(warnings.some((w) => w.code === 'ONE_WAY_MODE_MISSING')).toBe(true);
    expect(normalized[0]?.isPassengerOnly).toBe(true);
  });

  it('excludes requests already served by a fixed ride', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) })],
      fixedRides: [
        {
          id: 'fixed-1',
          carId: 'C1',
          window: { start: 32, end: 48 },
          originId: 'home',
          destinationId: 'home',
          driverRequestId: 'R1',
          driverMemberId: 'm1',
          legs: [],
          servedRequestIds: ['R1'],
          passengers: { adults: 1, childSeats: 0, boosters: 0 },
          luggageCount: 0,
          overnightAck: false,
          kind: 'pinned',
        },
      ],
    });
    const { normalized, servedByFixed } = normalize(input);
    expect(servedByFixed.has('R1')).toBe(true);
    expect(normalized).toHaveLength(0);
  });

  it('resolves "day" flexibility to the day bounds', () => {
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: [
        makeRequest({
          id: 'R1',
          departureMs: slotMs(32),
          returnMs: slotMs(48),
          flexDeparture: { earlierMin: 'day', laterMin: 0 },
        }),
      ],
    });
    const { normalized } = normalize(input);
    const day = dayBoundsForSlot(input.week.days, 32);
    expect(normalized[0]?.flexDep[0]).toBe(day.startSlot);
  });

  it('handles a DST week (92-slot Monday) without crossing days incorrectly', () => {
    const days = makeDstSpringWeekDays();
    const monday = days[1];
    expect(monday?.endSlot).toBe(96 + 92);
    const input = baseInput({
      week: { startMs: WEEK_START_MS, days },
      cars: [makeCar('C1')],
      requests: [
        makeRequest({
          id: 'R1',
          departureMs: WEEK_START_MS + (monday!.startSlot + 10) * 15 * 60 * 1000,
          returnMs: WEEK_START_MS + (monday!.startSlot + 20) * 15 * 60 * 1000,
          flexDeparture: { earlierMin: 'day', laterMin: 'day' },
        }),
      ],
    });
    const { normalized } = normalize(input);
    expect(normalized[0]?.flexDep).toEqual([monday!.startSlot, monday!.endSlot]);
    expect(normalized[0]?.dayIndex).toBe(1);
  });
});
