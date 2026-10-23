// src/solver/index.ts
//
// Public API of the pure scheduling solver (docs/SOLVER.md §2-§5). Pipeline:
// normalize -> seed fixed rides -> relay pairing -> score -> ordered greedy
// -> bounded improvement -> suggestions for what remains unmet ->
// assertInvariants -> SolverOutput. See src/solver/README.md for an overview
// and CLAUDE.md hard rule 5 for the purity contract this package upholds.

import { runSeriesRepair, suggestForSeries } from './seriesRepair';
import { buildUnits, runGreedy, sortUnits, toAssignments, type Placed, type PlacedSingle } from './greedy';
import { runImprove } from './improve';
import { runPooling, runRideAlong, seatAsGuest } from './pooling';
import { evictDriverlessForDrivers } from './driverFirst';
import { runPreferenceSwaps } from './preferenceSwaps';
import { assertInvariants } from './invariants';
import { fits, luggageFits } from './seatFit';
import { buildHostRides, findMergeHosts } from './merge';
import { scoreRequests } from './policy/engine';
import { oneWayUnmetCause, pairComplementaryOneWays, pairSameMemberOutAndBack } from './oneWayPairs';
import { chauffeurShortDropOffs, chauffeurUnpairedRelayLegs, pairRelays, pickupFromCarAtX } from './relay';
import { reason } from './reasons';
import { applyFallbacks } from './alternative';
import { expandDropOffs, restoreDropOffIds } from './dropOffSplit';
import { carName, memberName, placeName, rideHostLabel, requestDestName, requestOriginName } from './names';
import { byId, normalize, type NormalizedRequest } from './slots';
import { buildSuggestions, type SuggestionContext } from './suggestions';
import { buildTimelines, CarTimeline } from './timeline';
import { minutesToSlots } from './slots';
import type { Assignment, Car, SolverInput, SolverOutput, UnmetRequest } from './types';

export * from './types';
export { fits, dominates, slack, sum, luggageFits, chauffeurLoad } from './seatFit';
export { ruleRegistry, type RuleType } from './rules/index';
export { alternativeServedWeightOf, DEFAULT_ALTERNATIVE_SERVED_WEIGHT } from './rules/fairness';
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

/** A time the request could start: its own departure plus every start inside its departure flexibility. */
function candidateStarts(nr: NormalizedRequest): number[] {
  const from = Math.min(nr.flexDep[0], nr.window.start);
  const to = Math.max(nr.flexDep[1], nr.window.start);
  const starts: number[] = [];
  for (let s = from; s <= to; s++) {
    if (s >= nr.dayWindow.start && s < nr.dayWindow.end) starts.push(s);
  }
  return starts;
}

/** Whether `car` is free for the request at some candidate start — standing at its origin, or (with `anywhere`) wherever it is. */
function carFreeForRequest(tl: CarTimeline | undefined, nr: NormalizedRequest, anywhere: boolean): boolean {
  if (!tl) return false;
  return candidateStarts(nr).some((s) => {
    const w = { start: s, end: Math.min(s + nr.minDurationSlots, nr.dayWindow.end) };
    return tl.isFree(w, anywhere ? tl.locationAt(s) : nr.originId);
  });
}

/** Seats the request needs, its driver included. */
function seatCount(nr: NormalizedRequest): number {
  return nr.passengers.adults + nr.passengers.childSeats + nr.passengers.boosters;
}

/** The shared cars that seat the request and take its luggage, by name (R13B17: the busy ones the reason names). */
function seatCarNames(input: SolverInput, nr: NormalizedRequest): string {
  return input.cars
    .filter((c) => c.type === 'shared' && fits(c, nr.passengers) && luggageFits(c, nr.luggage ? 1 : 0))
    .map((c) => carName(input.cars, c.id))
    .filter(Boolean)
    .join(', ');
}

/** Some shared car that seats the request and takes its luggage is free for it, wherever it stands. */
function fittingCarFree(input: SolverInput, nr: NormalizedRequest, timelines: Map<string, CarTimeline>): boolean {
  return input.cars.some(
    (c) => c.type === 'shared' && fits(c, nr.passengers) && luggageFits(c, nr.luggage ? 1 : 0) && carFreeForRequest(timelines.get(c.id), nr, true),
  );
}

/**
 * R2B11, R13B17: the real cause of a plain "no car", as a code with matching text. The cars that could take the
 * request in time are looked at first: a fitting car free elsewhere → "no car at the origin"; no fitting car free
 * at all while the request needs something only some cars have (seats, child seats, a large trunk) → that need,
 * naming the busy cars that have it; everything busy → the blockers.
 */
function noCarReason(
  input: SolverInput,
  nr: NormalizedRequest,
  timelines: Map<string, CarTimeline>,
  blockers: { carId: string; rideIds: string[] }[],
): { code: string; text: string } {
  const shared = input.cars.filter((c) => c.type === 'shared');
  if (shared.length === 0) return { code: 'UNMET_NO_CAR_NONE', text: reason('UNMET_NO_CAR_NONE') };
  const seatOk = shared.filter((c) => fits(c, nr.passengers));
  if (seatOk.length === 0) return { code: 'UNMET_NO_CAR_SEATS', text: reason('UNMET_NO_CAR_SEATS') };
  const fitting = seatOk.filter((c) => luggageFits(c, nr.luggage ? 1 : 0));
  if (fitting.length === 0) return { code: 'UNMET_NO_CAR_LUGGAGE', text: reason('UNMET_NO_CAR_LUGGAGE') };
  const where = { origin: requestOriginName(input, nr.request, nr.originId), dest: requestDestName(input, nr.request) };
  if (!fitting.some((c) => carFreeForRequest(timelines.get(c.id), nr, false))) {
    const spanStart = Math.min(nr.flexDep[0], nr.window.start);
    const spanEnd = Math.max(nr.flexDep[1], nr.window.start) + nr.minDurationSlots;
    const standsAtOrigin = fitting.some((c) =>
      (timelines.get(c.id)?.gaps() ?? []).some((g) => g.locationId === nr.originId && g.window.start < spanEnd && spanStart < g.window.end),
    );
    if (!standsAtOrigin && fitting.some((c) => carFreeForRequest(timelines.get(c.id), nr, true))) {
      return { code: 'UNMET_NO_CAR_AT_ORIGIN', text: reason('UNMET_NO_CAR_AT_ORIGIN', where) };
    }
    if (seatOk.length < shared.length) {
      const code = nr.passengers.childSeats + nr.passengers.boosters > 0 ? 'UNMET_NO_CAR_SEATS_BUSY' : 'UNMET_SEATS_CARS_BUSY';
      return { code, text: reason(code, { cars: seatCarNames(input, nr), count: seatCount(nr) }) };
    }
    if (fitting.length < seatOk.length) {
      return { code: 'UNMET_LARGE_TRUNK_BUSY', text: reason('UNMET_LARGE_TRUNK_BUSY', { cars: seatCarNames(input, nr) }) };
    }
  }
  // One-way legs carry no blockers list: name the fitting cars that are busy for them.
  const blockerIds = blockers.length > 0
    ? blockers.map((b) => b.carId)
    : fitting.filter((c) => !carFreeForRequest(timelines.get(c.id), nr, true)).map((c) => c.id);
  const names = blockerIds.map((id) => carName(input.cars, id)).filter(Boolean).join(', ');
  return names
    ? { code: 'UNMET_NO_CAR', text: reason('UNMET_NO_CAR', { blockers: names }) }
    : { code: 'UNMET_NO_CAR_BUSY', text: reason('UNMET_NO_CAR_BUSY') };
}

/**
 * A drop-off with a pickup is solved as two independent one-way legs (REQUIREMENTS
 * §13.94, docs/SOLVER.md §1.3a) — see `dropOffSplit.ts`.
 */
export function solve(input: SolverInput): SolverOutput {
  return applyFallbacks(input, solveBase(input), solveBase);
}

/** The solve without the fallback pass (what a plan-B test solve runs on, REQ §13.112). */
function solveBase(input: SolverInput): SolverOutput {
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
  const roundTripsAll = normalized.filter((nr) => nr.legs[0]?.side === 'both' || nr.tripType === 'one_way');
  const oneWay = normalized.filter((nr) => nr.legs[0]?.side !== 'both' && nr.tripType !== 'one_way');
  const passengerOnly = oneWay.filter((nr) => nr.isPassengerOnly);
  const relayEligible = oneWay.filter((nr) => !nr.isPassengerOnly);

  const relayResult = pairRelays(relayEligible, input.cars, normalized.filter((nr) => !relayEligible.includes(nr)), 2 * bufferSlots);
  // REQ item 136 (d) (SOLVER §3.6.1d): the same member's out and back is a pair unit of the greedy pass
  // (ranked by the higher leg score), formed from the explicit one-way legs and the unpaired relay legs.
  const outAndBack = input.cars.some((c) => c.type === 'shared')
    ? pairSameMemberOutAndBack([...roundTripsAll.filter((nr) => nr.tripType === 'one_way'), ...relayResult.unpaired], input, normalized)
    : { pairs: [], usedIds: new Set<string>() };
  const pairs = [...relayResult.pairs, ...outAndBack.pairs];
  const unpaired = relayResult.unpaired.filter((nr) => !outAndBack.usedIds.has(nr.id));
  const roundTrips = roundTripsAll.filter((nr) => !outAndBack.usedIds.has(nr.id));

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

  // REQ item 136 (e) (SOLVER §3.16): a multi-day series that still has no car moves the short rides blocking one
  // (inside their own flexibility). Runs before pooling, so no pooled host/guest is ever a blocker.
  const seriesRepair = runSeriesRepair(improveResult.stillUnmetUnits, [...placedSingles, ...improveResult.newlyPlaced], timelines, input);

  // REQ §136 a (SOLVER §3.6.4): pooling pass, then the unmet units retry on the freed capacity.
  // Pooling runs after the improvement pass, so a host or guest is never relocated by `runImprove`.
  let finalPlaced: Placed[] = [...placed, ...improveResult.newlyPlaced, ...seriesRepair.newlyPlaced];
  let stillUnmetUnits = seriesRepair.stillUnmetUnits;
  if (input.config.sharedRides !== false) {
    const pooling = runPooling(finalPlaced, stillUnmetUnits, timelines, input, scores, carsMap);
    finalPlaced = pooling.placed;
    stillUnmetUnits = pooling.unmetUnits;
  }
  // REQ item 136 (b) (SOLVER §3.6.6): a drop-off leg first tries to ride along as a passenger in a placed ride
  // passing by, before it can become a chauffeur ride (the healing below only sees the legs nobody passes by).
  const ownPairFallback: NormalizedRequest[] = [];
  for (const u of stillUnmetUnits) {
    if (u.kind !== 'pair' || !u.pair) continue;
    // an out-and-back pair (item 136 d) that fits no car: explicit one-way legs are never chauffeured
    // (the post-pass below gets them), drop-off legs take the ordinary healing paths
    if (u.pair.pair.outAndBack) {
      for (const nr of [u.pair.outNr, u.pair.retNr]) if (nr.tripType !== 'one_way') ownPairFallback.push(nr);
      continue;
    }
    ownPairFallback.push(u.pair.outNr, u.pair.retNr);
  }
  const rideAlongPool = new Map<string, NormalizedRequest>();
  for (const nr of [...unpaired, ...ownPairFallback, ...passengerOnly]) rideAlongPool.set(nr.id, nr);
  const rideAlongIds = input.config.sharedRides !== false
    ? runRideAlong([...rideAlongPool.values()], finalPlaced, timelines, input, scores, carsMap)
    : new Set<string>();
  // REQ item 136 (f) (SOLVER §3.6.5): the fixing stage — on the finished plan, swap cars between placed rides
  // when that answers more preferences (window-preserving, never unplaces, never breaks a requirement).
  const preferenceSwaps = runPreferenceSwaps(finalPlaced, timelines, input, scores, carsMap).swaps;

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
  // R8B14: complementary explicit one-way legs (X -> Y with Y -> X) that blocked each other (the lone
  // leg strands the car's next ride, the return finds no car at Y) go together onto one car.
  // REQ item 136 (d) (SOLVER §3.6.1d): the same member's out and back (also overnight, nearby places) and an
  // unpaired one-leg drop-off join the same pass.
  const oneWayPairs = pairComplementaryOneWays(
    [...stillUnmetUnits.flatMap((u) => (u.kind === 'single' && u.single?.tripType === 'one_way' ? [u.single] : [])),
      ...unpaired.filter((nr) => !rideAlongIds.has(nr.id)),
      ...stillUnmetUnits.flatMap((u) => (u.kind === 'pair' && u.pair?.pair.outAndBack ? [u.pair.outNr, u.pair.retNr] : []))
        .filter((nr) => !rideAlongIds.has(nr.id))],
    timelines, input, carsMap, scores, normalized);
  // REQ §13.105 b: a pickup from X on a car already standing at X, driven home by the requester, comes first.
  const pickupCandidates = [...unpaired, ...ownPairFallback].filter((nr) => !rideAlongIds.has(nr.id) && !oneWayPairs.healedIds.has(nr.id));
  const pickups = pickupFromCarAtX(pickupCandidates, timelines, input, carsMap, scores);
  const chauffeured = chauffeurUnpairedRelayLegs(
    pickupCandidates.filter((nr) => !pickups.healedIds.has(nr.id)), timelines, input, carsMap, scores);
  const healed = [...pickups.healed, ...chauffeured.healed];
  const healedIds = new Set([...rideAlongIds, ...oneWayPairs.healedIds, ...pickups.healedIds, ...chauffeured.healedIds]);
  const stillUnpairedRelay = unpaired.filter((nr) => !healedIds.has(nr.id));
  // REQUIREMENTS §13.88 (owner 2026-09-24, docs/TODO.md Q7): a one-way leg with no eligible
  // driver on board gets the same missing-driver chauffeur ride the SQL healing gives it
  // (`try_widen_one_way_leg`), instead of staying unmet; only when no car has room does it
  // keep the UNMET_PASSENGER_NO_HOST path and its merge suggestions.
  // REQ §13.104b: a short drop-off + pickup with nobody needing the car meanwhile is one chauffeur ride.
  const passengerOnlyLeft = passengerOnly.filter((nr) => !rideAlongIds.has(nr.id));
  const shortRides = chauffeurShortDropOffs(passengerOnlyLeft, normalized, timelines, input, scores);
  const remainingPassengerOnly = passengerOnlyLeft.filter((nr) => !shortRides.healedIds.has(nr.id));
  const { healed: healedNoDriverSingles, healedIds: healedNoDriverSingleIds } =
    chauffeurUnpairedRelayLegs(remainingPassengerOnly, timelines, input, carsMap, scores, 'noDriver');
  const healedNoDriver = [...shortRides.healed, ...healedNoDriverSingles];
  const healedNoDriverIds = new Set([...rideAlongIds, ...shortRides.healedIds, ...healedNoDriverSingleIds]);

  // REQ item 136 (b) (SOLVER §3.6.7): a driverless ride never takes a car a driver needs.
  const driverFirst = evictDriverlessForDrivers(stillUnmetUnits, finalPlaced, [...healed, ...healedNoDriver], timelines, input);
  const evictedIds = driverFirst.evicted;
  // an evicted leg first tries to ride along with the driver who took its car (or any other ride passing by)
  const survivors = finalPlaced.filter((p) => !(p.kind === 'single' && driverFirst.removedRideIds.has(`ride:${p.nr.id}`)));
  const hostsAfter: Placed[] = [...survivors, ...driverFirst.newPlaced];
  const evictedOrder = [...evictedIds.keys()]
    .map((id) => byRequestId.get(id))
    .filter((nr): nr is NormalizedRequest => !!nr)
    .sort((a, b) => ((scores.get(b.id)?.total ?? 0) - (scores.get(a.id)?.total ?? 0)) || byId(a, b));
  if (input.config.sharedRides !== false) {
    for (const nr of evictedOrder) {
      const side = nr.legs[0]?.side ?? 'both';
      if (seatAsGuest(nr, side, hostsAfter, timelines, input, carsMap)) evictedIds.delete(nr.id);
    }
  }
  const solverAssignments = toAssignments(hostsAfter, input, carsMap);
  const stillPassengerOnly = passengerOnly.filter((nr) => !healedNoDriverIds.has(nr.id) || evictedIds.has(nr.id));
  stillUnmetUnits = stillUnmetUnits.filter((u) => !driverFirst.placedUnitIds.has(u.id));
  const notEvicted = (a: Assignment): boolean => !driverFirst.removedRideIds.has(a.rideId);

  const assignments = [...fixedAssignments, ...solverAssignments, ...oneWayPairs.healed, ...healed.filter(notEvicted), ...healedNoDriver.filter(notEvicted)].sort((a, b) => byId({ id: a.rideId }, { id: b.rideId }));

  const servedRequestIds = new Set<string>();
  for (const a of assignments) for (const rid of a.servedRequestIds) servedRequestIds.add(rid);

  // Build the final unmet pool: still-unmet greedy/improve units, unpaired relay legs, passenger-only requests.
  // Multi-day series units are handled entirely separately below — they never
  // get shift/merge/split/etc. suggestions (SOLVER §3.x): all-or-nothing, every
  // leg becomes UNMET_SERIES_NO_CAR with no suggestions.
  const unmetIds = new Map<string, NormalizedRequest>();
  const unmetSeriesUnits = stillUnmetUnits.filter((u) => u.kind === 'series' && u.series);
  for (const u of stillUnmetUnits) {
    if (u.kind === 'single' && u.single) {
      if (!oneWayPairs.healedIds.has(u.single.id)) unmetIds.set(u.single.id, u.single);
    }
    else if (u.kind === 'pair' && u.pair) {
      if (!healedIds.has(u.pair.outNr.id)) unmetIds.set(u.pair.outNr.id, u.pair.outNr);
      if (!healedIds.has(u.pair.retNr.id)) unmetIds.set(u.pair.retNr.id, u.pair.retNr);
    }
  }
  for (const nr of stillUnpairedRelay) unmetIds.set(nr.id, nr);
  for (const nr of stillPassengerOnly) unmetIds.set(nr.id, nr);
  for (const id of evictedIds.keys()) {
    const nr = byRequestId.get(id);
    if (nr) unmetIds.set(id, nr);
  }
  // Anything normalized but not served and not otherwise captured (defensive).
  for (const nr of normalized) if (!servedRequestIds.has(nr.id)) unmetIds.set(nr.id, unmetIds.get(nr.id) ?? nr);

  const hosts = buildHostRides(assignments, carsMap);
  // `findMergeHosts` looks a host's own request up by ride id (fixed hosts have none and stay absent).
  const hostRequestsByRide = new Map<string, NormalizedRequest>();
  for (const a of assignments) {
    if (a.source !== 'solver' || !a.driverRequestId) continue;
    const nr = byRequestId.get(a.driverRequestId);
    if (nr) hostRequestsByRide.set(a.rideId, nr);
  }
  const suggestionCtx: SuggestionContext = {
    input,
    assignments,
    timelines,
    hostDriverRequests: hostRequestsByRide,
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
      // R8B14: an explicit one-way leg says why for real (stranded next ride vs no car at the origin vs busy).
      const oneWayCause = nr.tripType === 'one_way' ? oneWayUnmetCause(nr, timelines, input) : { strands: false, atOrigin: false, awayAtWeekEnd: false };
      const takenBy = evictedIds.get(nr.id);
      const origin = requestOriginName(input, nr.request, nr.originId);
      const dest = requestDestName(input, nr.request);
      // R13B17: the code always matches the text; the plain "no car" path names the real blocker.
      const { code: reasonCode, text: reasonText } = takenBy !== undefined
        ? { code: 'UNMET_CAR_TO_DRIVER', text: reason('UNMET_CAR_TO_DRIVER', { member: memberName(input, byRequestId.get(takenBy)?.request.memberId), dest }) }
        : needsLargeTrunk
        ? { code: 'UNMET_NEEDS_LARGE_TRUNK', text: reason('UNMET_NEEDS_LARGE_TRUNK') }
        : seatsBusy
        ? { code: 'UNMET_NO_CAR_SEATS_BUSY', text: reason('UNMET_NO_CAR_SEATS_BUSY', { cars: seatCarNames(input, nr), count: seatCount(nr) }) }
        : stillPassengerOnly.includes(nr)
        ? { code: 'UNMET_PASSENGER_NO_HOST', text: reason('UNMET_NEEDS_DRIVER', { dest, dep: '' }) }
        : stillUnpairedRelay.includes(nr) && fittingCarFree(input, nr, timelines)
        ? { code: 'UNMET_NO_RELAY_PARTNER', text: reason('UNMET_NO_RELAY_PARTNER', { dest }) }
        : oneWayCause.strands
        ? { code: 'UNMET_ONE_WAY_STRANDS_CAR', text: reason('UNMET_ONE_WAY_STRANDS_CAR', { origin, dest }) }
        : oneWayCause.awayAtWeekEnd
        ? { code: 'UNMET_ONE_WAY_AWAY_AT_WEEK_END', text: reason('UNMET_ONE_WAY_AWAY_AT_WEEK_END', { dest }) }
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

  // Multi-day series (SOLVER §3.x): all-or-nothing — every leg of a series that could not be placed on one car
  // becomes its own UnmetRequest; the head leg carries the nearest-start/end suggestion (item 136 e), if any.
  for (const u of unmetSeriesUnits) {
    const su = u.series;
    if (!su) continue;
    const seriesScore = scores.get(su.scoreProxy.id)?.total ?? 0;
    const headSuggestions = suggestForSeries(
      su,
      finalPlaced.filter((p): p is PlacedSingle => p.kind === 'single'),
      timelines,
      input,
      scores,
    );
    const headRequestId = su.legs[0]?.requestId;
    for (const leg of su.legs) {
      unmet.push({
        requestId: leg.requestId,
        score: seriesScore,
        blockers: [],
        suggestions: leg.requestId === headRequestId ? headSuggestions : [],
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
      hostDriverRequests: hostRequestsByRide,
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
      relocations: improveResult.relocationsApplied.length + seriesRepair.relocations.length,
      ...(preferenceSwaps > 0 ? { preferenceSwaps } : {}),
      budgetExhausted: improveResult.budgetExhausted,
      elapsedMs: startedAt !== undefined ? (input.now?.() ?? startedAt) - startedAt : 0,
    },
  };

  assertInvariants(input, output);
  return output;
}

// Re-exported for callers/tests that want the raw sorting helper used by the greedy pass.
export { sortUnits };
