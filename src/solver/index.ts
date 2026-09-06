// src/solver/index.ts
//
// Public API of the pure scheduling solver (docs/SOLVER.md §2-§5). Pipeline:
// normalize -> seed fixed rides -> relay pairing -> score -> ordered greedy
// -> bounded improvement -> suggestions for what remains unmet ->
// assertInvariants -> SolverOutput. See src/solver/README.md for an overview
// and CLAUDE.md hard rule 5 for the purity contract this package upholds.

import { buildUnits, runGreedy, sortUnits, toAssignments, type Placed, type PlacedSingle } from './greedy';
import { runImprove } from './improve';
import { assertInvariants } from './invariants';
import { fits, luggageFits } from './seatFit';
import { buildHostRides, findMergeHosts } from './merge';
import { scoreRequests } from './policy/engine';
import { pairRelays } from './relay';
import { reason } from './reasons';
import { byId, normalize, type NormalizedRequest } from './slots';
import { buildSuggestions, type SuggestionContext } from './suggestions';
import { buildTimelines, CarTimeline } from './timeline';
import { minutesToSlots } from './slots';
import type { Assignment, Car, SolverInput, SolverOutput, UnmetRequest } from './types';

export * from './types';
export { fits, dominates, slack, sum, luggageFits, chauffeurLoad } from './seatFit';
export { ruleRegistry, type RuleType } from './rules/index';
export { matchFreedSlot, tryAutoApprove } from './live';
export { CarTimeline, buildTimelines } from './timeline';
export type { NormalizedRequest, NormalizedLeg } from './slots';

function peopleOf(nr: NormalizedRequest): number {
  return nr.passengers.adults + nr.passengers.childSeats + nr.passengers.boosters - 1;
}

function computeBlockers(nr: NormalizedRequest, timelines: Map<string, CarTimeline>, cars: Car[]): { carId: string; rideIds: string[] }[] {
  if (nr.legs[0]?.side !== 'both') return [];
  const envStart = nr.flexDep[0];
  const envEnd = nr.flexRet[1];
  const blockers: { carId: string; rideIds: string[] }[] = [];
  for (const car of cars.filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const tl = timelines.get(car.id);
    if (!tl) continue;
    if (!fits(car, nr.passengers) || !luggageFits(car, nr.luggage ? 1 : 0)) {
      blockers.push({ carId: car.id, rideIds: [] });
      continue;
    }
    const overlapping = tl
      .allBlocks()
      .filter((b) => b.window.start < envEnd && envStart < b.window.end)
      .map((b) => b.rideId);
    if (overlapping.length > 0) blockers.push({ carId: car.id, rideIds: overlapping });
  }
  return blockers;
}

export function solve(input: SolverInput): SolverOutput {
  const startedAt = input.now?.();
  const warnings: { code: string; message: string; requestId?: string }[] = [];

  const { normalized, warnings: normalizeWarnings } = normalize(input);
  warnings.push(...normalizeWarnings.map((w) => ({ code: w.code, message: w.message, requestId: w.requestId })));

  const bufferSlots = minutesToSlots(input.config.bufferMinutes);
  const weekSlots = input.week.days.reduce((max, d) => Math.max(max, d.endSlot), 0);
  const timelines = buildTimelines(input.cars, bufferSlots, weekSlots, input.homeLocationId);
  const carsMap = new Map(input.cars.map((c) => [c.id, c]));

  const fixedAssignments: Assignment[] = [];
  for (const fr of [...input.fixedRides].sort((a, b) => byId(a, b))) {
    const tl = timelines.get(fr.carId);
    if (tl) {
      const actualLocation = tl.locationAt(fr.window.start);
      if (actualLocation !== fr.originId) {
        warnings.push({ code: 'FIXED_RIDE_LOCATION_MISMATCH', message: reason('WARN_FIXED_RIDE_LOCATION_MISMATCH'), requestId: fr.id });
      }
      tl.forceAdd({
        rideId: fr.id,
        window: fr.window,
        startLocationId: fr.originId,
        endLocationId: fr.destinationId,
        overnightAck: fr.overnightAck,
      });
    }
    fixedAssignments.push({
      rideId: fr.id,
      carId: fr.carId,
      window: fr.window,
      originId: fr.originId,
      destinationId: fr.destinationId,
      driverRequestId: fr.driverRequestId,
      driverMemberId: fr.driverMemberId,
      legs: fr.legs,
      servedRequestIds: fr.servedRequestIds,
      passengers: fr.passengers,
      luggageCount: fr.luggageCount,
      shift: { departureMin: 0, returnMin: 0 },
      source: 'fixed',
      reasonCode: 'PLACED_FIXED',
      reason: reason('PLACED_FIXED'),
    });
  }
  for (const car of input.cars.filter((c) => c.type === 'shared')) {
    const tl = timelines.get(car.id);
    if (!tl) continue;
    const violations = tl.dayEndViolations(input.week.days);
    for (const v of violations) {
      warnings.push({ code: 'CAR_AWAY_AT_DAY_END', message: reason('WARN_CAR_AWAY_AT_DAY_END'), requestId: v.causeRideId });
    }
  }

  const roundTrips = normalized.filter((nr) => nr.legs[0]?.side === 'both');
  const oneWay = normalized.filter((nr) => nr.legs[0]?.side !== 'both');
  const passengerOnly = oneWay.filter((nr) => nr.isPassengerOnly);
  const relayEligible = oneWay.filter((nr) => !nr.isPassengerOnly);

  const { pairs, unpaired } = pairRelays(relayEligible, input.cars);

  const relayPairPeople = new Map<string, number>();
  for (const pair of pairs) {
    const out = normalized.find((nr) => nr.id === pair.outRequestId);
    const ret = normalized.find((nr) => nr.id === pair.returnRequestId);
    if (!out || !ret) continue;
    const combined = peopleOf(out) + peopleOf(ret);
    relayPairPeople.set(out.id, combined);
    relayPairPeople.set(ret.id, combined);
  }

  const { scores, warnings: scoreWarnings } = scoreRequests(input, normalized, relayPairPeople);
  warnings.push(...scoreWarnings.map((w) => ({ code: w.code, message: w.message, requestId: w.requestId })));

  const byRequestId = new Map(normalized.map((nr) => [nr.id, nr]));
  const units = buildUnits(roundTrips, pairs, byRequestId, scores);
  const { placed, unmetUnits } = runGreedy(units, timelines, input);

  const placedSingles = placed.filter((p): p is PlacedSingle => p.kind === 'single');
  const improveResult = runImprove(unmetUnits, placedSingles, timelines, input, scores);

  const finalPlaced: Placed[] = [...placed, ...improveResult.newlyPlaced];
  const solverAssignments = toAssignments(finalPlaced, input, carsMap);
  const assignments = [...fixedAssignments, ...solverAssignments].sort((a, b) => byId({ id: a.rideId }, { id: b.rideId }));

  const servedRequestIds = new Set<string>();
  for (const a of assignments) for (const rid of a.servedRequestIds) servedRequestIds.add(rid);

  // Build the final unmet pool: still-unmet greedy/improve units, unpaired relay legs, passenger-only requests.
  const unmetIds = new Map<string, NormalizedRequest>();
  for (const u of improveResult.stillUnmetUnits) {
    if (u.kind === 'single' && u.single) unmetIds.set(u.single.id, u.single);
    else if (u.kind === 'pair' && u.pair) {
      unmetIds.set(u.pair.outNr.id, u.pair.outNr);
      unmetIds.set(u.pair.retNr.id, u.pair.retNr);
    }
  }
  for (const nr of unpaired) unmetIds.set(nr.id, nr);
  for (const nr of passengerOnly) unmetIds.set(nr.id, nr);
  // Anything normalized but not served and not otherwise captured (defensive).
  for (const nr of normalized) if (!servedRequestIds.has(nr.id)) unmetIds.set(nr.id, unmetIds.get(nr.id) ?? nr);

  const hosts = buildHostRides(assignments, carsMap);
  const suggestionCtx: SuggestionContext = {
    input,
    assignments,
    timelines,
    hostDriverRequests: byRequestId,
    unpairedRelay: unpaired,
    ejectionSuggestions: improveResult.ejectionSuggestions,
  };

  const unmet: UnmetRequest[] = [...unmetIds.values()]
    .sort((a, b) => byId(a, b))
    .map((nr) => {
      const blockers = computeBlockers(nr, timelines, input.cars);
      const suggestions = buildSuggestions(
        nr,
        suggestionCtx,
        blockers.map((b) => b.carId),
      );
      const reasonCode = passengerOnly.includes(nr)
        ? 'UNMET_PASSENGER_NO_HOST'
        : unpaired.includes(nr)
          ? 'UNMET_NO_RELAY_PARTNER'
          : 'UNMET_NO_CAR';
      const reasonText =
        reasonCode === 'UNMET_NO_RELAY_PARTNER'
          ? reason('UNMET_NO_RELAY_PARTNER', { dest: nr.destinationId, dayEnd: '23:59' })
          : reasonCode === 'UNMET_PASSENGER_NO_HOST'
            ? reason('UNMET_NEEDS_DRIVER', { dest: nr.destinationId, dep: '' })
            : reason('UNMET_NO_CAR', { blockers: blockers.map((b) => b.carId).join(', ') });
      return {
        requestId: nr.id,
        score: scores.get(nr.id)?.total ?? 0,
        blockers,
        suggestions,
        reasonCode,
        reason: reasonText,
      };
    });

  // Informational merge opportunities between already-assigned solver rides.
  const mergeOpportunities: SolverOutput['mergeOpportunities'] = [];
  const solverHosts = hosts.filter((h) => !h.isFixed);
  for (const guestHost of solverHosts) {
    const guestNr = byRequestId.get(guestHost.driverRequestId);
    if (!guestNr) continue;
    const candidates = findMergeHosts({
      guest: guestNr,
      leg: guestHost.legSide,
      hosts: solverHosts.filter((h) => h.rideId !== guestHost.rideId),
      destinations: input.destinations,
      config: input.config,
      cars: carsMap,
      hostDriverRequests: byRequestId,
      hostTimelines: timelines,
    });
    const best = candidates[0];
    if (best && best.detourMinutes === 0) {
      mergeOpportunities.push({
        hostRideId: best.hostRideId,
        guestRideId: guestHost.rideId,
        freedCarId: guestHost.carId,
        freedWindow: guestHost.window,
        detourMinutes: best.detourMinutes,
        reason: reason('SUGGEST_MERGE', { host: best.hostRideId, dest: guestNr.destinationId, dep: '', ret: '' }),
      });
    }
  }

  const carsAway: SolverOutput['carsAway'] = [];
  for (const car of input.cars.filter((c) => c.type === 'shared')) {
    const tl = timelines.get(car.id);
    if (!tl) continue;
    for (const away of tl.awayWindows()) {
      carsAway.push({ carId: car.id, locationId: away.locationId, window: away.window });
    }
  }

  const needsDriver = unmet.filter((u) => u.suggestions.some((s) => s.kind === 'chauffeur')).length;

  const output: SolverOutput = {
    policyId: input.policy.id,
    policyVersion: input.policy.version,
    assignments,
    unmet,
    mergeOpportunities,
    carsAway,
    warnings,
    stats: {
      served: servedRequestIds.size,
      unmet: unmet.length,
      needsDriver,
      relocations: improveResult.relocationsApplied.length,
      budgetExhausted: improveResult.budgetExhausted,
      elapsedMs: startedAt !== undefined ? (input.now?.() ?? startedAt) - startedAt : 0,
    },
  };

  assertInvariants(input, output);
  return output;
}

// Re-exported for callers/tests that want the raw sorting helper used by the greedy pass.
export { sortUnits };
