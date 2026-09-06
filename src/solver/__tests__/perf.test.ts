// Performance fixture (docs/SOLVER.md §6, §7.1): 300 requests x 15 cars must
// complete well under the 10s requirement; CI asserts < 2s for margin.

import { describe, expect, it } from 'vitest';
import { solve } from '../index';
import {
  baseInput,
  defaultConfig,
  defaultPolicy,
  defaultStats,
  makeCar,
  makeDestinations,
  makeWeekDays,
  mulberry32,
  passengers,
  slotMs,
  WEEK_START_MS,
} from '../__fixtures__/gen';
import type { Car, Request, SolverInput } from '../types';

const DEST_IDS = ['destA', 'destB'];
const RIDE_TYPES = ['work', 'healthcare', 'childcare', 'errands', 'other'];
const FLEX_OPTIONS = [0, 15, 30, 60] as const;

function buildPerfInput(): SolverInput {
  const rand = mulberry32(42);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  const cars: Car[] = Array.from({ length: 15 }, (_, i) =>
    makeCar(`C${i}`, {
      seatConfigs: [passengers(4, 0, 0), passengers(2, 1, 0), passengers(3, 0, 1)],
      luggageCapacity: rand() > 0.7 ? 2 : 1,
      features: rand() > 0.7 ? ['large_trunk'] : [],
    }),
  );

  const requests: Request[] = Array.from({ length: 300 }, (_, i) => {
    const dayOffset = Math.floor(rand() * 6); // Sun..Fri, keep Saturday free for slack
    const departHourSlot = 96 * dayOffset + 20 + Math.floor(rand() * 48); // within the day
    const durationSlots = 8 + Math.floor(rand() * 24);
    const isOneWay = rand() > 0.85;
    const tripShape = isOneWay ? (rand() > 0.5 ? 'one_way_to' : 'one_way_from') : 'round_trip';

    const base = {
      id: `R${i}`,
      memberId: `member-${i % 60}`,
      departmentId: 'dept-1',
      destinationId: pick(DEST_IDS),
      rideType: pick(RIDE_TYPES),
      passengers: passengers(1 + Math.floor(rand() * 3)),
      coRiderMemberIds: [],
      luggage: rand() > 0.85,
      submittedAtMs: Math.floor(rand() * 100000),
      isLate: rand() > 0.9,
    };

    if (tripShape === 'round_trip') {
      return {
        ...base,
        tripShape,
        departureMs: slotMs(departHourSlot),
        returnMs: slotMs(departHourSlot + durationSlots),
        flexDeparture: { earlierMin: pick(FLEX_OPTIONS), laterMin: pick(FLEX_OPTIONS) },
        flexReturn: { earlierMin: pick(FLEX_OPTIONS), laterMin: pick(FLEX_OPTIONS) },
        needsCarAtDestination: rand() > 0.2,
      };
    }
    if (tripShape === 'one_way_to') {
      return {
        ...base,
        tripShape,
        oneWayCarMode: rand() > 0.5 ? 'relay' : 'passenger',
        departureMs: slotMs(departHourSlot),
        flexDeparture: { earlierMin: pick(FLEX_OPTIONS), laterMin: pick(FLEX_OPTIONS) },
        flexReturn: { earlierMin: 0, laterMin: 0 },
        needsCarAtDestination: true,
      };
    }
    return {
      ...base,
      tripShape,
      oneWayCarMode: rand() > 0.5 ? 'relay' : 'passenger',
      returnMs: slotMs(departHourSlot + durationSlots),
      flexDeparture: { earlierMin: 0, laterMin: 0 },
      flexReturn: { earlierMin: pick(FLEX_OPTIONS), laterMin: pick(FLEX_OPTIONS) },
      needsCarAtDestination: true,
    };
  });

  return baseInput({
    week: { startMs: WEEK_START_MS, days: makeWeekDays() },
    destinations: makeDestinations(),
    policy: defaultPolicy(),
    stats: defaultStats(),
    config: defaultConfig(),
    cars,
    requests,
  });
}

describe('performance: 300 requests x 15 cars', () => {
  it('completes in under 2 seconds and produces a valid, fully-accounted output', () => {
    const input = buildPerfInput();
    let now = 0;
    const start = performance.now();
    const output = solve({ ...input, now: () => now++ });
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(2000);
    expect(output.assignments.length + output.unmet.length).toBeGreaterThan(0);
    // budgetExhausted may legitimately be true on a fixture this size; invariants already held (solve() would have thrown otherwise).
    expect(typeof output.stats.budgetExhausted).toBe('boolean');

    const servedOrUnmet = new Set<string>();
    for (const a of output.assignments) for (const rid of a.servedRequestIds) servedOrUnmet.add(rid);
    for (const u of output.unmet) servedOrUnmet.add(u.requestId);
    expect(servedOrUnmet.size).toBe(input.requests.length);
  });
});
