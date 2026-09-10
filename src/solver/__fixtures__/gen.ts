// src/solver/__fixtures__/gen.ts
//
// Builders for tests and fixtures: a full working week of DayBounds, a
// default SolverConfig, and small helpers to build Car/Request objects
// without repeating boilerplate. Also a seeded PRNG for the performance
// fixture generator (no Math.random() inside the solver package itself —
// this file is test-only support code, not part of the solver).

import type {
  Car,
  DayBounds,
  Destination,
  Flexibility,
  Passengers,
  Policy,
  Request,
  SolverConfig,
  SolverInput,
  SolverStats,
} from '../types';

export const HOME = 'home';

/** A full Sun..Sat week of 96-slot days starting at weekStartMs (a Sunday 00:00). */
export function makeWeekDays(): DayBounds[] {
  const days: DayBounds[] = [];
  for (let i = 0; i < 7; i++) {
    const start = i * 96;
    days.push({ dayIndex: i as DayBounds['dayIndex'], startSlot: start, endSlot: start + 96, dayEndSlot: start + 95 });
  }
  return days;
}

/** A DST-affected week: Monday (index 1) has only 92 slots (spring-forward). */
export function makeDstSpringWeekDays(): DayBounds[] {
  const days: DayBounds[] = [];
  let cursor = 0;
  for (let i = 0; i < 7; i++) {
    const slots = i === 1 ? 92 : 96;
    days.push({ dayIndex: i as DayBounds['dayIndex'], startSlot: cursor, endSlot: cursor + slots, dayEndSlot: cursor + slots - 1 });
    cursor += slots;
  }
  return days;
}

export const WEEK_START_MS = Date.UTC(2026, 0, 4); // an arbitrary fixed Sunday 00:00 (no wall-clock math inside the solver)

export function slotMs(slot: number): number {
  return WEEK_START_MS + slot * 15 * 60 * 1000;
}

export function defaultConfig(overrides: Partial<SolverConfig> = {}): SolverConfig {
  return {
    bufferMinutes: 30,
    detour: { maxMinutes: 20, maxKm: 15 },
    beyondFlexMaxMinutes: 120,
    defaultTravelMinutes: 60,
    chauffeurDwellMinutes: 10,
    improvementBudget: 5000,
    perRequestBudget: 200,
    externalHints: { cabMaxMinutes: 90, rentalMinHours: 30, ptMinScore: 0.6 },
    ...overrides,
  };
}

export function noFlex(): Flexibility {
  return { earlierMin: 0, laterMin: 0 };
}
export function flex(earlierMin: number | 'day', laterMin: number | 'day'): Flexibility {
  return { earlierMin, laterMin };
}

export function passengers(adults = 1, childSeats = 0, boosters = 0): Passengers {
  return { adults, childSeats, boosters };
}

export function makeCar(id: string, overrides: Partial<Car> = {}): Car {
  return {
    id,
    name: id,
    type: 'shared',
    seatConfigs: [passengers(4, 0, 0)],
    features: [],
    luggageCapacity: 1,
    maintenance: [],
    ...overrides,
  };
}

let requestSeq = 0;
export function makeRequest(overrides: Partial<Request> = {}): Request {
  requestSeq += 1;
  return {
    id: overrides.id ?? `R${requestSeq}`,
    memberId: overrides.memberId ?? `member-${requestSeq}`,
    departmentId: 'dept-1',
    destinationId: 'destA',
    rideType: 'other',
    tripShape: 'round_trip',
    flexDeparture: noFlex(),
    flexReturn: noFlex(),
    passengers: passengers(1),
    coRiderMemberIds: [],
    luggage: false,
    needsCarAtDestination: true,
    submittedAtMs: 0,
    isLate: false,
    ...overrides,
  };
}

/**
 * Builds the in-week legs of a multi-day series request (docs/SOLVER.md
 * §3.x): one Request row per calendar day sharing `seriesId`. `dayIndices`
 * are 0-based week days for each in-week leg, ascending. Pass
 * `globalFirstIndex > 1` to model a continuation whose earlier legs already
 * happened in a previous week (the mapper sets the car's `startLocationId`
 * to the series destination in that case — see makeCar's `startLocationId`).
 */
export function makeSeriesLegs(opts: {
  seriesId: string;
  seriesCount: number;
  dayIndices: number[];
  globalFirstIndex?: number;
  destinationId?: string;
  memberId?: string;
  passengers?: Passengers;
  departureSlotOfDay?: number;
  returnSlotOfDay?: number;
  flexDeparture?: Flexibility;
  flexReturn?: Flexibility;
}): Request[] {
  const {
    seriesId,
    seriesCount,
    dayIndices,
    destinationId = 'destA',
    memberId = 'member-series',
    passengers: pax = passengers(1),
    departureSlotOfDay = 32,
    returnSlotOfDay = 48,
    flexDeparture = noFlex(),
    flexReturn = noFlex(),
  } = opts;
  const globalFirstIndex = opts.globalFirstIndex ?? 1;
  const SLOT_MS_LOCAL = 15 * 60 * 1000;
  return dayIndices.map((dayIndex, i) => {
    const seriesIndex = globalFirstIndex + i;
    const isGlobalFirst = seriesIndex === 1;
    const isGlobalLast = seriesIndex === seriesCount;
    const dayStart = dayIndex * 96;
    const departureMs = isGlobalFirst ? slotMs(dayStart + departureSlotOfDay) : slotMs(dayStart);
    const returnMs = isGlobalLast
      ? slotMs(dayStart + returnSlotOfDay)
      : WEEK_START_MS + (dayStart + 96) * SLOT_MS_LOCAL - 60_000; // exactly 23:59:00 that day
    return makeRequest({
      id: `${seriesId}-leg${seriesIndex}`,
      memberId,
      destinationId,
      passengers: pax,
      seriesId,
      seriesIndex,
      seriesCount,
      departureMs,
      returnMs,
      flexDeparture: isGlobalFirst ? flexDeparture : noFlex(),
      flexReturn: isGlobalLast ? flexReturn : noFlex(),
    });
  });
}

export function makeDestinations(): Record<string, Destination> {
  return {
    destA: { id: 'destA', zone: 'zoneA', distanceKm: 20, travelMinutes: 30, publicTransportScore: 0.2 },
    destB: { id: 'destB', zone: 'zoneB', distanceKm: 40, travelMinutes: 45, publicTransportScore: 0.5 },
    [HOME]: { id: HOME, zone: 'home' },
  };
}

export function defaultPolicy(): Policy {
  return {
    id: 'test-policy',
    version: 1,
    rules: [
      { type: 'rideType', weight: 1, params: { weights: { work: 8, healthcare: 10, childcare: 8, other: 5, errands: 3 } } },
      { type: 'distance', weight: 0.4, params: { maxKm: 60 } },
      { type: 'publicTransport', weight: 0.3, params: {} },
      { type: 'peopleServed', weight: 0.3, params: { cap: 4 } },
      { type: 'fairness', weight: 0.5, params: { lookbackWeeks: 3 } },
      { type: 'submissionTime', weight: 0.2, params: { latePenalty: 1 } },
      { type: 'flexibilityOffered', weight: 0.2, params: { fullCreditMinutes: 240 } },
      { type: 'manualBoost', weight: 2, params: {} },
    ],
  };
}

export function defaultStats(): SolverStats {
  return { fairness: {}, usualCarId: {} };
}

export function baseInput(overrides: Partial<SolverInput> = {}): SolverInput {
  return {
    week: { startMs: WEEK_START_MS, days: makeWeekDays() },
    homeLocationId: HOME,
    cars: [],
    requests: [],
    fixedRides: [],
    destinations: makeDestinations(),
    policy: defaultPolicy(),
    stats: defaultStats(),
    config: defaultConfig(),
    ...overrides,
  };
}

/** Deterministic seeded PRNG (mulberry32) — test-only, never used inside src/solver itself. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
