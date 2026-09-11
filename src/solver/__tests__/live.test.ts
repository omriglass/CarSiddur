import { describe, expect, it } from 'vitest';
import { matchFreedSlot } from '../live';
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
