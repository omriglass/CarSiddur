// src/solver/__tests__/seriesRepair.test.ts
//
// REQUIREMENTS item 136 (e), docs/SOLVER.md §3.16: a multi-day series is placed early, repaired by moving the
// short rides that block a car (inside their own flexibility), and explained by a nearest-start suggestion
// when it still finds no car.

import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import { buildTimelines, CarTimeline } from '../index';
import { assertInvariants } from '../invariants';
import { buildUnits, runGreedy, type PlacedSingle } from '../greedy';
import { normalize, minutesToSlots } from '../slots';
import { suggestSeriesDisplacement, MIN_FIRST_DAY_SLOTS } from '../seriesRepair';
import type { FixedRide, Request, SolverInput } from '../types';
import { baseInput, flex, makeCar, makeRequest, makeSeriesLegs, passengers, slotMs } from '../__fixtures__/gen';

const DAY = 96;
const THU = 3;

function thursdaySeries(id = 'S'): Request[] {
  return makeSeriesLegs({ seriesId: id, seriesCount: 3, dayIndices: [THU, THU + 1, THU + 2] });
}

/** A short round trip on Thursday 08:00-10:00 with a boost that makes it outrank the series clearly. */
function thursdayRide(overrides: Partial<Request> = {}): Request {
  return makeRequest({
    id: 'SHORT',
    memberId: 'member-short',
    destinationId: 'destB',
    departureMs: slotMs(THU * DAY + 32),
    returnMs: slotMs(THU * DAY + 40),
    manualBoost: { value: 1, reason: 'test' },
    preferredCarId: 'C1',
    ...overrides,
  });
}

function fixed(id: string, carId: string, start: number, end: number): FixedRide {
  return {
    id,
    carId,
    window: { start, end },
    originId: 'home',
    destinationId: 'home',
    driverMemberId: 'someone',
    legs: [],
    servedRequestIds: [],
    passengers: passengers(1),
    luggageCount: 0,
    overnightAck: false,
    kind: 'pinned',
  };
}

function check(input: SolverInput) {
  const output = solve(input);
  assertInvariants(input, output);
  expect(solve(input)).toEqual(output);
  return output;
}

describe('series repair (item 136 e)', () => {
  it('moves a short blocker to another car inside its flexibility and places the series', () => {
    const legs = thursdaySeries();
    const input = baseInput({
      cars: [makeCar('C1'), makeCar('C2')],
      requests: [...legs, thursdayRide({ flexDeparture: flex(0, 240), flexReturn: flex(0, 240) })],
      // C2 is busy on Friday, so the series cannot go there and C1 is the only candidate
      fixedRides: [fixed('F', 'C2', (THU + 1) * DAY + 40, (THU + 1) * DAY + 60)],
    });
    const output = check(input);

    expect(output.unmet).toEqual([]);
    for (const leg of legs) {
      expect(output.assignments.find((a) => a.rideId === `ride:${leg.id}`)?.carId).toBe('C1');
    }
    const short = output.assignments.find((a) => a.rideId === 'ride:SHORT');
    expect(short?.carId).toBe('C2');
    expect(short?.shift).toEqual({ departureMin: 0, returnMin: 0 });
    expect(output.stats.relocations).toBe(1);
  });

  it('does not move a blocker outside its flexibility: the series stays unmet with a nearest-start suggestion', () => {
    const legs = thursdaySeries();
    const input = baseInput({
      cars: [makeCar('C1'), makeCar('C2')],
      requests: [...legs, thursdayRide()],
      // C2 is not free for the short ride at its own time, and not free for the series before 11:30
      fixedRides: [fixed('F', 'C2', THU * DAY + 28, THU * DAY + 44)],
    });
    const output = check(input);

    expect(output.assignments.find((a) => a.rideId === 'ride:SHORT')?.carId).toBe('C1');
    expect(output.stats.relocations).toBe(0);
    const head = output.unmet.find((u) => u.requestId === 'S-leg1');
    expect(head?.reasonCode).toBe('UNMET_SERIES_NO_CAR');
    // C1 is free again after the short ride (ends 10:00) plus the 30-minute turnaround: 10:30 on Thursday.
    expect(head?.suggestions).toHaveLength(1);
    const s = head?.suggestions[0];
    expect(s?.kind).toBe('shiftBeyondFlex');
    if (s?.kind !== 'shiftBeyondFlex') throw new Error('unreachable');
    expect(s.carId).toBe('C1');
    expect(s.window.start).toBe(THU * DAY + 42);
    expect(s.shift).toEqual({ departureMin: 10 * 15, returnMin: 0 });
    expect(s.reason).toContain('10:30');
    // only the head leg carries it
    expect(output.unmet.filter((u) => u.requestId !== 'S-leg1').every((u) => u.suggestions.length === 0)).toBe(true);
  });

  it('never moves a fixed ride', () => {
    const legs = thursdaySeries();
    const input = baseInput({
      cars: [makeCar('C1'), makeCar('C2')],
      requests: legs,
      fixedRides: [fixed('F1', 'C1', THU * DAY + 32, THU * DAY + 40), fixed('F2', 'C2', (THU + 1) * DAY + 40, (THU + 1) * DAY + 60)],
    });
    const output = check(input);

    expect(output.stats.relocations).toBe(0);
    expect(output.assignments.find((a) => a.rideId === 'F1')?.window).toEqual({ start: THU * DAY + 32, end: THU * DAY + 40 });
    expect(output.assignments.find((a) => a.rideId === 'F2')?.carId).toBe('C2');
    expect(output.unmet.map((u) => u.requestId)).toEqual(['S-leg1', 'S-leg2', 'S-leg3']);
  });

  it('places a series before a slightly higher-priority single, but yields to a clearly higher one', () => {
    const legs = thursdaySeries();
    const middleDay = (extra: Partial<Request>) =>
      makeRequest({
        id: 'MID',
        memberId: 'member-mid',
        destinationId: 'destB',
        departureMs: slotMs((THU + 1) * DAY + 32),
        returnMs: slotMs((THU + 1) * DAY + 48),
        ...extra,
      });

    const slight = check(baseInput({ cars: [makeCar('C1')], requests: [...legs, middleDay({ rideType: 'work' })] }));
    expect(slight.assignments.some((a) => a.rideId === 'ride:S-leg1')).toBe(true);
    expect(slight.unmet.map((u) => u.requestId)).toEqual(['MID']);

    const clear = check(baseInput({ cars: [makeCar('C1')], requests: [...legs, middleDay({ manualBoost: { value: 1, reason: 'test' } })] }));
    expect(clear.assignments.some((a) => a.servedRequestIds.includes('MID'))).toBe(true);
    expect(clear.unmet.map((u) => u.requestId)).toEqual(['S-leg1', 'S-leg2', 'S-leg3']);
  });

  it('suggests the trip without its first day when the nearest free start leaves < 2 h of the first day', () => {
    const legs = thursdaySeries();
    // C1 is busy (fixed) until Thursday 23:00 + 30 min turnaround = 23:30: the nearest start would be 23:30
    const input = baseInput({
      cars: [makeCar('C1')],
      requests: legs,
      fixedRides: [fixed('F', 'C1', THU * DAY + 30, THU * DAY + 92)],
    });
    const output = check(input);
    const head = output.unmet.find((u) => u.requestId === 'S-leg1');
    expect(head?.suggestions).toHaveLength(1);
    const s = head?.suggestions[0];
    if (s?.kind !== 'shiftBeyondFlex') throw new Error('expected shiftBeyondFlex');
    expect(s.reasonCode).toBe('SUGGEST_SERIES_SPAN_FEWER_DAYS');
    expect(s.carId).toBe('C1');
    expect(s.window.start).toBe((THU + 1) * DAY);
    expect(s.reason).toContain('חמישי');
    expect(s.reason).toContain('יום אחד פחות');
    expect(output.unmet.filter((u) => u.requestId !== 'S-leg1').every((u) => u.suggestions.length === 0)).toBe(true);
  });

  it('offers a start later on the first day only while at least 2 h of it remain', () => {
    expect(MIN_FIRST_DAY_SLOTS).toBe(8);
    const legs = thursdaySeries();
    // free from Thursday 21:30 (fixed ends 21:00): 2 h 30 min of the day remain, still a start-later suggestion
    const ok = check(baseInput({ cars: [makeCar('C1')], requests: legs, fixedRides: [fixed('F', 'C1', THU * DAY + 30, THU * DAY + 84)] }));
    const s = ok.unmet.find((u) => u.requestId === 'S-leg1')?.suggestions[0];
    expect(s?.reasonCode).toBe('SUGGEST_SERIES_SPAN_START');
    // free from 22:30 (fixed ends 22:00): only 1 h 30 min remain, next-day option instead
    const late = check(baseInput({ cars: [makeCar('C1')], requests: legs, fixedRides: [fixed('F', 'C1', THU * DAY + 30, THU * DAY + 88)] }));
    expect(late.unmet.find((u) => u.requestId === 'S-leg1')?.suggestions[0]?.reasonCode).toBe('SUGGEST_SERIES_SPAN_FEWER_DAYS');
  });

  it('offers nothing when the next-day span is blocked too', () => {
    const legs = thursdaySeries();
    const output = check(
      baseInput({
        cars: [makeCar('C1')],
        requests: legs,
        fixedRides: [fixed('F', 'C1', THU * DAY + 30, THU * DAY + 92), fixed('G', 'C1', (THU + 1) * DAY + 40, (THU + 1) * DAY + 50)],
      }),
    );
    expect(output.unmet.find((u) => u.requestId === 'S-leg1')?.suggestions).toEqual([]);
  });

  it('never offers displacement of a fixed or a higher-priority ride', () => {
    const legs = thursdaySeries();
    const fixedBlock = check(baseInput({ cars: [makeCar('C1')], requests: legs, fixedRides: [fixed('F', 'C1', THU * DAY + 32, THU * DAY + 40)] }));
    expect(fixedBlock.unmet.find((u) => u.requestId === 'S-leg1')?.suggestions.some((s) => s.reasonCode === 'SUGGEST_SERIES_DISPLACE')).toBe(false);
    const boosted = check(baseInput({ cars: [makeCar('C1')], requests: [...legs, thursdayRide()] }));
    expect(boosted.unmet.find((u) => u.requestId === 'S-leg1')?.suggestions.some((s) => s.reasonCode === 'SUGGEST_SERIES_DISPLACE')).toBe(false);
  });
});

/** Places `singles` greedily with the given scores (as if they were placed before the series), then asks for the displacement. */
function displacement(input: SolverInput, scoreOf: Record<string, number>, seriesScore = 1) {
  const { normalized, seriesUnits } = normalize(input);
  const su = seriesUnits[0]!;
  const timelines = buildTimelines(input.cars, minutesToSlots(input.config.bufferMinutes), input.week.days.at(-1)!.endSlot, input.homeLocationId);
  const scores = new Map<string, { total: number }>([[su.scoreProxy.id, { total: seriesScore }]]);
  for (const nr of normalized) scores.set(nr.id, { total: scoreOf[nr.id] ?? 0 });
  const byId = new Map(normalized.map((nr) => [nr.id, nr]));
  const { placed } = runGreedy(buildUnits(normalized, [], byId, scores), timelines, input);
  const singles = placed.filter((p): p is PlacedSingle => p.kind === 'single');
  return { su, singles, timelines, scores, out: suggestSeriesDisplacement(su, singles, timelines, input, scores) };
}

describe('series displacement suggestion (item 136 e, 2026-10-17)', () => {
  const withName = (r: Request, name: string): Request => ({ ...r, memberName: name });

  it('names an equal-priority non-flexible blocker; relocations list it with toCarId empty', () => {
    const legs = thursdaySeries();
    const eq = withName(thursdayRide({ id: 'EQ', manualBoost: undefined, preferredCarId: undefined }), 'דנה');
    const input = baseInput({ cars: [makeCar('C1')], requests: [...legs, eq] });
    const { out, singles, timelines } = displacement(input, { EQ: 1 });
    expect(singles.map((p) => p.nr.id)).toEqual(['EQ']);
    if (out?.kind !== 'shiftWithinFlex') throw new Error('expected shiftWithinFlex');
    expect(out.reasonCode).toBe('SUGGEST_SERIES_DISPLACE');
    expect(out.carId).toBe('C1');
    expect(out.relocations).toEqual([expect.objectContaining({ rideId: 'ride:EQ', fromCarId: 'C1', toCarId: '' })]);
    expect(out.reason).toContain('דנה');
    expect(out.reason).not.toContain('EQ');
    // dry run: the timeline is left exactly as it was
    const tl = timelines.get('C1') as CarTimeline;
    expect(tl.isFree({ start: THU * DAY + 32, end: THU * DAY + 40 }, input.homeLocationId)).toBe(false);
  });

  it('is deterministic', () => {
    const input = baseInput({ cars: [makeCar('C1')], requests: [...thursdaySeries(), thursdayRide({ id: 'EQ', manualBoost: undefined })] });
    expect(displacement(input, { EQ: 1 }).out).toEqual(displacement(input, { EQ: 1 }).out);
  });

  it('refuses a clearly higher-priority blocker (above the series score + SERIES_EARLY_BONUS)', () => {
    const input = baseInput({ cars: [makeCar('C1')], requests: [...thursdaySeries(), thursdayRide({ id: 'HI', manualBoost: undefined })] });
    expect(displacement(input, { HI: 2.5 }).out).toBeNull();
  });

  it('offers a blocker of similar priority (within SERIES_EARLY_BONUS of the series) — the greedy order\'s own measure', () => {
    const input = baseInput({ cars: [makeCar('C1')], requests: [...thursdaySeries(), thursdayRide({ id: 'HI', manualBoost: undefined })] });
    const out = displacement(input, { HI: 1.5 }).out;
    expect(out?.kind).toBe('shiftWithinFlex');
    expect(out?.kind === 'shiftWithinFlex' ? out.relocations : []).toEqual([expect.objectContaining({ rideId: 'ride:HI', toCarId: '' })]);
  });

  it('relocates what can move inside its flexibility and displaces only the rest', () => {
    const legs = thursdaySeries();
    const movable = withName(
      thursdayRide({ id: 'MOVE', memberId: 'm-move', manualBoost: undefined, preferredCarId: 'C1', flexDeparture: flex(0, 240), flexReturn: flex(0, 240) }),
      'משה',
    );
    // large luggage: only C1 takes it, so it cannot move to C2
    const stuck = withName(
      thursdayRide({
        id: 'STUCK', memberId: 'm-stuck', manualBoost: undefined, preferredCarId: 'C1', luggage: true, destinationId: 'destA',
        departureMs: slotMs((THU + 1) * DAY + 32), returnMs: slotMs((THU + 1) * DAY + 40),
      }),
      'שרה',
    );
    const input = baseInput({
      cars: [makeCar('C1'), makeCar('C2', { luggageCapacity: 0 })],
      requests: [...legs, movable, stuck],
    });
    const { out } = displacement(input, { MOVE: 1, STUCK: 0.5 });
    if (out?.kind !== 'shiftWithinFlex') throw new Error('expected shiftWithinFlex');
    expect(out.carId).toBe('C1');
    const byRide = new Map(out.relocations.map((r) => [r.rideId, r]));
    expect(byRide.get('ride:MOVE')?.toCarId).toBe('C2');
    expect(byRide.get('ride:STUCK')?.toCarId).toBe('');
    expect(out.reason).toContain('שרה');
    expect(out.reason).not.toContain('משה');
  });
});
