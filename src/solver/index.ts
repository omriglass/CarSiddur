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
import { chauffeurShortDropOffs, chauffeurUnpairedRelayLegs, pairRelays } from './relay';
import { reason } from './reasons';
import { expandDropOffs, restoreDropOffIds } from './dropOffSplit';
import { carName, placeName, rideHostLabel, requestDestName, requestOriginName } from './names';
import { byId, normalize, type NormalizedRequest } from './slots';
import { buildSuggestions, type SuggestionContext } from './suggestions';
import { buildTimelines, CarTimeline } from './timeline';
import { minutesToSlots } from './slots';
import type { Assignment, Car, SolverInput, SolverOutput, UnmetRequest } from './types';

export * from './types';
export { fits, dominates, slack, sum, luggageFits, chauffeurLoad } from './seatFit';
export { ruleRegistry, type RuleType } from './rules/index';
export { matchFreedSlot } from './live';
export { CarTimeline, buildTimelines } from './timeline';
export type { NormalizedRequest, NormalizedLeg, SeriesLeg, SeriesUnit } from './slots';
// REQUIREMENTS §13.93 (docs/SOLVER.md §1.3a): origin helpers, for callers
// (the DB->solver bridge, O5) that need to resolve/derive the same things
// the solver does internally.
export { effectiveTripType, originIdOf, travelBetween } from './travel';
export type { TravelResult, TravelLookup } from './travel';

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

/** R2B11: name the real cause of a plain "no car" (never an empty blockers list). */
function noCarReason(
  input: SolverInput,
  nr: NormalizedRequest,
  timelines: Map<string, CarTimeline>,
  blockers: { carId: string; rideIds: string[] }[],
): string {
  const shared = input.cars.filter((c) => c.type === 'shared');
  if (shared.length === 0) return reason('UNMET_NO_CAR_NONE');
  const seatOk = shared.filter((c) => fits(c, nr.passengers));
  if (shared.length > 0 && seatOk.length === 0) return reason('UNMET_NO_CAR_SEATS');
  const fitting = seatOk.filter((c) => luggageFits(c, nr.luggage ? 1 : 0));
  if (shared.length > 0 && fitting.length === 0) return reason('UNMET_NO_CAR_LUGGAGE');
  const atOrigin = fitting.some((c) =>
    (timelines.get(c.id)?.gaps() ?? []).some(
      (g) => g.locationId === nr.originId && g.window.start < nr.window.end && nr.window.start < g.window.end,
    ),
  );
  if (!atOrigin) {
    return reason('UNMET_NO_CAR_AT_ORIGIN', {
      origin: requestOriginName(input, nr.request, nr.originId),
      dest: requestDestName(input, nr.request),
    });
  }
  const names = blockers.map((b) => carName(input.cars, b.carId)).filter(Boolean).join(', ');
  return names ? reason('UNMET_NO_CAR', { blockers: names }) : reason('UNMET_NO_CAR_BUSY');
}

/**
 * A drop-off with a pickup is solved as two independent one-way legs (REQUIREMENTS
 * §13.94, docs/SOLVER.md §1.3a) — see `dropOffSplit.ts`.
 */
export function solve(input: SolverInput): SolverOutput {
  const { input: expanded, splitIds } = expandDropOffs(input);
  return restoreDropOffIds(solveExpanded(expanded), splitIds);
}

function solveExpanded(input: SolverInput): SolverOutput {
  const startedAt = input.now?.();
  const warnings: { code: string; message: string; requestId?: string }[] = [];

  const { normalized, warnings: normalizeWarnings, seriesUnits, freeTextOriginIds } = normalize(input);
  warnings.push(...normalizeWarnings.map((w) => ({ code: w.code, message: w.message, requestId: w.requestId })));

  const bufferSlots = minutesToSlots(input.config.bufferMinutes);
  const weekSlots = input.week.days.reduce((max, d) => Math.max(max, d.endSlot), 0);
  const timelines = buildTimelines(input.cars, bufferSlots, weekSlots, input.homeLocationId);
  const carsMap = new Map(input.cars.map((c) => [c.id, c]));

  const fixedAssignments: Assignment[] = [];
  for (const fr of [...input.fixedRides].sort((a, b) => byId(a, b))) {
    const tl = timelines.get(fr.carId);
    if (tl) {
      tl.forceAdd({
        rideId: fr.id,
        window: fr.window,
        startLocationId: fr.originId,
        endLocationId: fr.destinationId,
        overnightAck: fr.overnightAck,
        approvedBufferAfterSlots: fr.approvedBufferAfterSlots,
        locationNeutral: fr.locationNeutral,
        seriesId: fr.seriesId,
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
      ...(fr.seriesId ? { seriesId: fr.seriesId } : {}),
      reasonCode: 'PLACED_FIXED',
      reason: reason('PLACED_FIXED'),
    });
  }
  // REQUIREMENTS §13.93: the day-end rule is retired. A fixed ride that
  // starts where the car actually is not still goes in (chain break,
  // recorded by `forceAdd`/`chainBreaks()` instead of a mismatch warning at
  // seed time); only ending the *week* away from its base is worth a warning.
  for (const tl of timelines.values()) {
    for (const rideId of tl.fixedConflicts()) {
      warnings.push({ code: 'FIXED_RIDE_CONFLICT', message: reason('WARN_FIXED_RIDE_CONFLICT'), requestId: rideId });
    }
  }
  for (const car of input.cars.filter((c) => c.type === 'shared')) {
    const tl = timelines.get(car.id);
    if (!tl) continue;
    for (const brk of tl.chainBreaks()) {
      warnings.push({ code: 'CHAIN_BROKEN', message: reason('WARN_CHAIN_BROKEN'), requestId: brk.rideId });
    }
  }

  // REQUIREMENTS §13.93: an explicit `one_way` trip type has no pairing
  // obligation — it is placed directly as a single unit (origin -> destination,
  // end-check only) alongside ordinary 'both'/keep round trips, never through
  // relay pairing/chauffeur healing (which stays scoped to `drop_off`, the
  // legacy-derived default for every one-way/needsCarAtDestination=false case).
  const roundTrips = normalized.filter((nr) => nr.legs[0]?.side === 'both' || nr.tripType === 'one_way');
  const oneWay = normalized.filter((nr) => nr.legs[0]?.side !== 'both' && nr.tripType !== 'one_way');
  const passengerOnly = oneWay.filter((nr) => nr.isPassengerOnly);
  const relayEligible = oneWay.filter((nr) => !nr.isPassengerOnly);

  const { pairs, unpaired } = pairRelays(relayEligible, input.cars, normalized.filter((nr) => !relayEligible.includes(nr)));

  const relayPairPeople = new Map<string, number>();
  for (const pair of pairs) {
    const out = normalized.find((nr) => nr.id === pair.outRequestId);
    const ret = normalized.find((nr) => nr.id === pair.returnRequestId);
    if (!out || !ret) continue;
    const combined = peopleOf(out) + peopleOf(ret);
    relayPairPeople.set(out.id, combined);
    relayPairPeople.set(ret.id, combined);
  }

  // Multi-day series (SOLVER §3.x) are scored via a proxy built from their first
  // in-week leg, included in the same batch so minmax-normalized rules compare
  // fairly against ordinary requests.
  const scoringBatch = [...normalized, ...seriesUnits.map((su) => su.scoreProxy)];
  const { scores, warnings: scoreWarnings } = scoreRequests(input, scoringBatch, relayPairPeople);
  warnings.push(...scoreWarnings.map((w) => ({ code: w.code, message: w.message, requestId: w.requestId })));

  const byRequestId = new Map(normalized.map((nr) => [nr.id, nr]));
  const units = buildUnits(roundTrips, pairs, byRequestId, scores, seriesUnits);
  const { placed, unmetUnits } = runGreedy(units, timelines, input);

  const placedSingles = placed.filter((p): p is PlacedSingle => p.kind === 'single');
  const improveResult = runImprove(unmetUnits, placedSingles, timelines, input, scores);

  const finalPlaced: Placed[] = [...placed, ...improveResult.newlyPlaced];
  const solverAssignments = toAssignments(finalPlaced, input, carsMap);

  // REQUIREMENTS §13.88/§13.89 (rule made precise 2026-09-16): an unpaired relay
  // candidate is never placed as a lone relay leg (that would leave the car
  // waiting at the destination) — it becomes a standalone chauffeur placement
  // instead (SOLVER §3.6.1a). Legs this cannot heal (no car has room for the
  // whole chauffeur window) keep the old UNMET_NO_RELAY_PARTNER path.
  // REQUIREMENTS §13.95 (H2): when the connected pair of one drop-off-with-pickup (both halves of a split
  // request, driven by the requester) fits on no car, each half falls back to this same
  // chauffeur path instead of staying unmet.
  // R4B1: this holds for every unmet pair unit (own connected pair or a cross-request relay pair): a
  // pair that fits on no car leaves its legs unpaired, so each leg gets the chauffeur path in this same
  // click — otherwise the next solve (partner now fixed) places them and auto-fill never finishes.
  const ownPairFallback: NormalizedRequest[] = [];
  for (const u of improveResult.stillUnmetUnits) {
    if (u.kind !== 'pair' || !u.pair) continue;
    ownPairFallback.push(u.pair.outNr, u.pair.retNr);
  }
  const { healed, healedIds } = chauffeurUnpairedRelayLegs([...unpaired, ...ownPairFallback], timelines, input, carsMap, scores);
  const stillUnpairedRelay = unpaired.filter((nr) => !healedIds.has(nr.id));
  // REQUIREMENTS §13.88 (owner 2026-09-24, docs/TODO.md Q7): a one-way leg with no eligible
  // driver on board gets the same missing-driver chauffeur ride the SQL healing gives it
  // (`try_widen_one_way_leg`), instead of staying unmet; only when no car has room does it
  // keep the UNMET_PASSENGER_NO_HOST path and its merge suggestions.
  // REQ §13.104b: a short drop-off + pickup with nobody needing the car meanwhile is one chauffeur ride.
  const shortRides = chauffeurShortDropOffs(passengerOnly, normalized, timelines, input, scores);
  const remainingPassengerOnly = passengerOnly.filter((nr) => !shortRides.healedIds.has(nr.id));
  const { healed: healedNoDriverSingles, healedIds: healedNoDriverSingleIds } =
    chauffeurUnpairedRelayLegs(remainingPassengerOnly, timelines, input, carsMap, scores, 'noDriver');
  const healedNoDriver = [...shortRides.healed, ...healedNoDriverSingles];
  const healedNoDriverIds = new Set([...shortRides.healedIds, ...healedNoDriverSingleIds]);
  const stillPassengerOnly = passengerOnly.filter((nr) => !healedNoDriverIds.has(nr.id));

  const assignments = [...fixedAssignments, ...solverAssignments, ...healed, ...healedNoDriver].sort((a, b) => byId({ id: a.rideId }, { id: b.rideId }));

  const servedRequestIds = new Set<string>();
  for (const a of assignments) for (const rid of a.servedRequestIds) servedRequestIds.add(rid);

  // Build the final unmet pool: still-unmet greedy/improve units, unpaired relay legs, passenger-only requests.
  // Multi-day series units are handled entirely separately below — they never
  // get shift/merge/split/etc. suggestions (SOLVER §3.x): all-or-nothing, every
  // leg becomes UNMET_SERIES_NO_CAR with no suggestions.
  const unmetIds = new Map<string, NormalizedRequest>();
  const unmetSeriesUnits = improveResult.stillUnmetUnits.filter((u) => u.kind === 'series' && u.series);
  for (const u of improveResult.stillUnmetUnits) {
    if (u.kind === 'single' && u.single) unmetIds.set(u.single.id, u.single);
    else if (u.kind === 'pair' && u.pair) {
      if (!healedIds.has(u.pair.outNr.id)) unmetIds.set(u.pair.outNr.id, u.pair.outNr);
      if (!healedIds.has(u.pair.retNr.id)) unmetIds.set(u.pair.retNr.id, u.pair.retNr);
    }
  }
  for (const nr of stillUnpairedRelay) unmetIds.set(nr.id, nr);
  for (const nr of stillPassengerOnly) unmetIds.set(nr.id, nr);
  // Anything normalized but not served and not otherwise captured (defensive).
  for (const nr of normalized) if (!servedRequestIds.has(nr.id)) unmetIds.set(nr.id, unmetIds.get(nr.id) ?? nr);

  const hosts = buildHostRides(assignments, carsMap);
  const suggestionCtx: SuggestionContext = {
    input,
    assignments,
    timelines,
    hostDriverRequests: byRequestId,
    unpairedRelay: stillUnpairedRelay,
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
      const needsLargeTrunk =
        nr.luggage && !input.cars.some((c) => c.type === 'shared' && c.luggageCapacity >= 1);
      // REQ §13.104c: a child's leg that only lacks a child-seat car says so, not "no relay partner".
      const leg0 = nr.legs[0];
      const seatsBusy =
        stillUnpairedRelay.includes(nr) &&
        nr.passengers.childSeats + nr.passengers.boosters > 0 &&
        !!leg0 &&
        (() => {
          const fit = input.cars.filter((c) => c.type === 'shared' && fits(c, nr.passengers));
          return fit.length === 0 || fit.every((c) => !timelines.get(c.id)?.isFree(leg0.window, nr.originId));
        })();
      const reasonCode = needsLargeTrunk
        ? 'UNMET_NEEDS_LARGE_TRUNK'
        : seatsBusy
        ? 'UNMET_NO_CAR_SEATS_BUSY'
        : stillPassengerOnly.includes(nr)
        ? 'UNMET_PASSENGER_NO_HOST'
        : stillUnpairedRelay.includes(nr)
          ? 'UNMET_NO_RELAY_PARTNER'
          : nr.tripType === 'one_way'
            ? 'UNMET_NO_CAR_AT_ORIGIN'
            : 'UNMET_NO_CAR';
      const reasonText =
        reasonCode === 'UNMET_NEEDS_LARGE_TRUNK'
          ? reason('UNMET_NEEDS_LARGE_TRUNK')
          : reasonCode === 'UNMET_NO_CAR_SEATS_BUSY'
          ? reason('UNMET_NO_CAR_SEATS_BUSY')
          : reasonCode === 'UNMET_NO_RELAY_PARTNER'
          ? reason('UNMET_NO_RELAY_PARTNER', { dest: requestDestName(input, nr.request) })
          : reasonCode === 'UNMET_PASSENGER_NO_HOST'
            ? reason('UNMET_NEEDS_DRIVER', { dest: requestDestName(input, nr.request), dep: '' })
            : reasonCode === 'UNMET_NO_CAR_AT_ORIGIN'
              ? reason('UNMET_NO_CAR_AT_ORIGIN', { origin: requestOriginName(input, nr.request, nr.originId), dest: requestDestName(input, nr.request) })
              : noCarReason(input, nr, timelines, blockers);
      return {
        requestId: nr.id,
        score: scores.get(nr.id)?.total ?? 0,
        blockers,
        suggestions,
        reasonCode,
        reason: reasonText,
      };
    });

  // REQUIREMENTS §13.93, ORIGINS_PLAN §4 item 5: a free-text origin is never
  // normalized and never placed — no score, no suggestions beyond a plain
  // deny (there is nowhere to merge/shift/chauffeur it to or from).
  for (const requestId of [...freeTextOriginIds].sort()) {
    unmet.push({
      requestId,
      score: 0,
      blockers: [],
      suggestions: [{ kind: 'deny', requestId, reasonCode: 'SUGGEST_DENY', reason: reason('SUGGEST_DENY', { blockers: '' }), cost: 0, confidence: 1 }],
      reasonCode: 'UNMET_FREE_TEXT_ORIGIN',
      reason: reason('UNMET_FREE_TEXT_ORIGIN'),
    });
  }

  // Multi-day series (SOLVER §3.x): all-or-nothing, no suggestions — every leg
  // of a series that could not be placed on one car becomes its own
  // UnmetRequest with an empty suggestions list.
  for (const u of unmetSeriesUnits) {
    const su = u.series;
    if (!su) continue;
    const seriesScore = scores.get(su.scoreProxy.id)?.total ?? 0;
    for (const leg of su.legs) {
      unmet.push({
        requestId: leg.requestId,
        score: seriesScore,
        blockers: [],
        suggestions: [],
        reasonCode: 'UNMET_SERIES_NO_CAR',
        reason: reason('UNMET_SERIES_NO_CAR', { index: leg.seriesIndex, count: su.seriesCount }),
      });
    }
  }
  unmet.sort((a, b) => byId({ id: a.requestId }, { id: b.requestId }));

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
      homeLocationId: input.homeLocationId,
      travel: input.travel,
    });
    const best = candidates[0];
    if (best && best.detourMinutes === 0) {
      mergeOpportunities.push({
        hostRideId: best.hostRideId,
        guestRideId: guestHost.rideId,
        freedCarId: guestHost.carId,
        freedWindow: guestHost.window,
        detourMinutes: best.detourMinutes,
        reason: reason('SUGGEST_MERGE', { host: rideHostLabel(input, assignments, best.hostRideId), dest: requestDestName(input, guestNr.request), dep: '', ret: '' }),
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
    // REQUIREMENTS §13.93: the day-end rule is gone; the only remaining
    // location warning is a car ending the whole *week* away from its base.
    const endAway = tl.weekEndAway();
    if (endAway) {
      warnings.push({ code: 'CAR_AWAY_AT_WEEK_END', message: reason('WARN_CAR_AWAY_AT_WEEK_END', { car: car.name, place: placeName(input, endAway.locationId) }) });
    }
  }

  // REQUIREMENTS §13.88/§13.89: counts both still-unplaced legs that only have a
  // chauffeur suggestion, and solver-placed rides that already need a driver —
  // a non-driver's driverless round trip (PLACED_NEEDS_DRIVER) and an unpaired
  // relay candidate's standalone chauffeur placement (PLACED_CHAUFFEUR_NO_RETURNER).
  const needsDriverUnmet = unmet.filter((u) => u.suggestions.some((s) => s.kind === 'chauffeur')).length;
  const needsDriverAssignments = assignments.filter((a) => a.source === 'solver' && !a.driverRequestId && !a.driverMemberId).length;
  const needsDriver = needsDriverUnmet + needsDriverAssignments;

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
