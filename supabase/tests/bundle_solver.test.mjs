#!/usr/bin/env node
// supabase/tests/bundle_solver.test.mjs
//
// Plain-Node smoke test for the bundled solver (supabase/functions/_shared/solver.js),
// run by `npm run functions:bundle` right after scripts/bundle-solver.mjs regenerates
// it. Proves the ESM bundle Edge Functions actually import (a) loads with no
// external/npm resolution and (b) produces the same result as the equivalent
// src/solver Vitest smoke test (src/solver/__tests__/smoke.test.ts), so a broken
// bundle step is caught before it ever reaches an Edge Function.

import assert from 'node:assert/strict';
import { solve } from '../functions/_shared/solver.js';

const SLOT_MS = 15 * 60 * 1000;
const WEEK_START_MS = Date.UTC(2026, 0, 4); // an arbitrary Sunday 00:00
const slotMs = (slot) => WEEK_START_MS + slot * SLOT_MS;

function makeWeekDays() {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const start = i * 96;
    days.push({ dayIndex: i, startSlot: start, endSlot: start + 96, dayEndSlot: start + 95 });
  }
  return days;
}

const input = {
  week: { startMs: WEEK_START_MS, days: makeWeekDays() },
  homeLocationId: 'home',
  cars: [
    {
      id: 'C1',
      name: 'C1',
      type: 'shared',
      seatConfigs: [{ adults: 4, childSeats: 0, boosters: 0 }],
      features: [],
      luggageCapacity: 1,
      maintenance: [],
    },
  ],
  requests: [
    {
      id: 'R1',
      memberId: 'member-1',
      departmentId: 'dept-1',
      destinationId: 'destA',
      rideType: 'other',
      tripShape: 'round_trip',
      departureMs: slotMs(32), // 08:00
      returnMs: slotMs(48), // 12:00
      flexDeparture: { earlierMin: 0, laterMin: 0 },
      flexReturn: { earlierMin: 0, laterMin: 0 },
      passengers: { adults: 1, childSeats: 0, boosters: 0 },
      coRiderMemberIds: [],
      luggage: false,
      needsCarAtDestination: true,
      submittedAtMs: 0,
      isLate: false,
    },
  ],
  fixedRides: [],
  destinations: {
    destA: { id: 'destA', zone: 'zoneA', distanceKm: 20, travelMinutes: 30, publicTransportScore: 0.2 },
    home: { id: 'home', zone: 'home' },
  },
  policy: {
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
  },
  stats: { fairness: {}, usualCarId: {} },
  config: {
    bufferMinutes: 30,
    detour: { maxMinutes: 20, maxKm: 15 },
    beyondFlexMaxMinutes: 120,
    defaultTravelMinutes: 60,
    chauffeurDwellMinutes: 10,
    improvementBudget: 5000,
    perRequestBudget: 200,
    externalHints: { cabMaxMinutes: 90, rentalMinHours: 30, ptMinScore: 0.6 },
  },
};

const output = solve(input);

assert.equal(output.unmet.length, 0, 'expected the single request to be placed, not unmet');
assert.equal(output.assignments.length, 1, 'expected exactly one assignment');
assert.equal(output.assignments[0].carId, 'C1');
assert.equal(output.assignments[0].reasonCode, 'PLACED_PREFERRED');
assert.equal(output.stats.served, 1);

console.log('[bundle_solver.test] OK — bundled solver.solve() placed the request as expected');
