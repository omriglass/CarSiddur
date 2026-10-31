import { describe, expect, it } from 'vitest';
import { freedSlotOptions, matchFreedSlot } from '../live';
import { CarTimeline } from '../timeline';
import { defaultConfig, defaultPolicy, defaultStats, makeCar, makeDestinations, makeRequest, makeWeekDays, slotMs, WEEK_START_MS } from '../__fixtures__/gen';

const HOME = 'home';
const WEEK = { startMs: WEEK_START_MS, days: makeWeekDays() };

describe('matchFreedSlot', () => {
  it('zero candidates when the freed window is away from home', () => {
    const car = makeCar('C1');
    const tl = new CarTimeline(car, 2, 96 * 7, HOME);
    const result = matchFreedSlot({
      car,
      timeline: tl,
      freedWindow: { start: 32, end: 48 },
      freedLocationId: 'destA',
      candidates: [makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) })],
      destinations: makeDestinations(),
      policy: defaultPolicy(),
      stats: defaultStats(),
      config: defaultConfig(),
      week: WEEK,
      homeLocationId: HOME,
    });
    expect(result).toEqual([]);
  });

  it('one candidate matches and is returned', () => {
    const car = makeCar('C1');
    const tl = new CarTimeline(car, 2, 96 * 7, HOME);
    const result = matchFreedSlot({
      car,
      timeline: tl,
      freedWindow: { start: 32, end: 48 },
      freedLocationId: HOME,
      candidates: [makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) })],
      destinations: makeDestinations(),
      policy: defaultPolicy(),
      stats: defaultStats(),
      config: defaultConfig(),
      week: WEEK,
      homeLocationId: HOME,
    });
    expect(result.map((r) => r.requestId)).toEqual(['R1']);
  });

  it('several candidates all matching are all returned, ranked by score then shift then id', () => {
    const car = makeCar('C1');
    const tl = new CarTimeline(car, 2, 96 * 7, HOME);
    const result = matchFreedSlot({
      car,
      timeline: tl,
      freedWindow: { start: 32, end: 48 },
      freedLocationId: HOME,
      candidates: [
        makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) }),
        makeRequest({ id: 'R2', departureMs: slotMs(32), returnMs: slotMs(48) }),
      ],
      destinations: makeDestinations(),
      policy: defaultPolicy(),
      stats: defaultStats(),
      config: defaultConfig(),
      week: WEEK,
      homeLocationId: HOME,
    });
    expect(result).toHaveLength(2);
  });

  it('one-way requests are never candidates', () => {
    const car = makeCar('C1');
    const tl = new CarTimeline(car, 2, 96 * 7, HOME);
    const result = matchFreedSlot({
      car,
      timeline: tl,
      freedWindow: { start: 32, end: 48 },
      freedLocationId: HOME,
      candidates: [makeRequest({ id: 'R1', tripShape: 'one_way_to', oneWayCarMode: 'relay', departureMs: slotMs(32) })],
      destinations: makeDestinations(),
      policy: defaultPolicy(),
      stats: defaultStats(),
      config: defaultConfig(),
      week: WEEK,
      homeLocationId: HOME,
    });
    expect(result).toEqual([]);
  });

  it('uses flex placement into a merged gap when the exact freed window needs a small shift', () => {
    const car = makeCar('C1');
    const tl = new CarTimeline(car, 2, 96 * 7, HOME);
    // Candidate's preferred window is slightly later than the freed window, but within its flex.
    const result = matchFreedSlot({
      car,
      timeline: tl,
      freedWindow: { start: 30, end: 50 },
      freedLocationId: HOME,
      candidates: [
        makeRequest({
          id: 'R1',
          departureMs: slotMs(34),
          returnMs: slotMs(50),
          flexDeparture: { earlierMin: 30, laterMin: 0 },
          flexReturn: { earlierMin: 0, laterMin: 0 },
        }),
      ],
      destinations: makeDestinations(),
      policy: defaultPolicy(),
      stats: defaultStats(),
      config: defaultConfig(),
      week: WEEK,
      homeLocationId: HOME,
    });
    expect(result).toHaveLength(1);
  });

  it('never relocates an existing ride — the timeline passed in is read-only from its perspective', () => {
    const car = makeCar('C1');
    const tl = new CarTimeline(car, 2, 96 * 7, HOME);
    tl.add({ rideId: 'existing', window: { start: 60, end: 70 }, startLocationId: HOME, endLocationId: HOME, overnightAck: false });
    matchFreedSlot({
      car,
      timeline: tl,
      freedWindow: { start: 32, end: 48 },
      freedLocationId: HOME,
      candidates: [makeRequest({ id: 'R1', departureMs: slotMs(32), returnMs: slotMs(48) })],
      destinations: makeDestinations(),
      policy: defaultPolicy(),
      stats: defaultStats(),
      config: defaultConfig(),
      week: WEEK,
      homeLocationId: HOME,
    });
    expect(tl.has('existing')).toBe(true);
    expect(tl.allBlocks()).toHaveLength(1); // no candidate block was ever added
  });
});

describe('freedSlotOptions (REQ §13.168)', () => {
  // Gap 07:00–24:00 in slots of the first day; turnaround 2 slots (30 min).
  const gap = { start: 28, end: 96 };
  const item = (requestId: string, start: number, end: number, score: number, planB = false) => ({ requestId, window: { start, end }, score, planB });

  it("lists each candidate alone and every chain that fits one after another (the owner's example)", () => {
    const options = freedSlotOptions([
      item('planB7to17', 28, 68, 0.6, true),   // 07:00–17:00, served by plan B
      item('wait19to22', 76, 88, 0.5),         // 19:00–22:00
      item('wait10to12', 40, 48, 0.7),         // 10:00–12:00
    ], gap, 2);
    expect(options.map((o) => o.requestIds)).toEqual([
      ['wait10to12', 'wait19to22'],
      ['planB7to17', 'wait19to22'],
      ['wait10to12'],
      ['planB7to17'],
      ['wait19to22'],
    ]);
    expect(options[0]?.recommended).toBe(true);
    expect(options.filter((o) => o.recommended)).toHaveLength(1);
    expect(options[1]?.planB).toBe(1);
  });

  it('needs the turnaround between two requests of a chain', () => {
    const tight = freedSlotOptions([item('A', 28, 40, 1), item('B', 41, 50, 1)], gap, 2);
    expect(tight.some((o) => o.requestIds.length === 2)).toBe(false);
    const ok = freedSlotOptions([item('A', 28, 40, 1), item('B', 42, 50, 1)], gap, 2);
    expect(ok[0]?.requestIds).toEqual(['A', 'B']);
  });

  it('has no size limit on a chain and leaves out what does not fit the gap', () => {
    const four = freedSlotOptions([item('A', 28, 32, 1), item('B', 34, 38, 1), item('C', 40, 44, 1), item('D', 46, 50, 1), item('late', 90, 100, 5)], gap, 2);
    expect(four[0]?.requestIds).toEqual(['A', 'B', 'C', 'D']);
    expect(four.some((o) => o.requestIds.includes('late'))).toBe(false);
  });

  it('breaks score ties by unused time, then by fewer plan-B moves, deterministically', () => {
    const options = freedSlotOptions([item('long', 28, 80, 1), item('short', 28, 40, 1), item('planBLong', 28, 80, 1, true)], gap, 2);
    expect(options.map((o) => o.requestIds[0])).toEqual(['long', 'planBLong', 'short']);
    expect(freedSlotOptions([], gap, 2)).toEqual([]);
  });
});
