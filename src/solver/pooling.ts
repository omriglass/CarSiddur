// src/solver/pooling.ts
//
// Shared rides are the default (REQUIREMENTS item 136 a, docs/SOLVER.md §3.6.4). After the greedy and
// improvement passes, placed round trips are seated as passengers in another placed ride going the same
// way, which frees their car; the still-unmet units are then retried on the freed capacity, and the two
// steps repeat until a round pools nothing and places nothing (each request is pooled at most once, so the
// loop is bounded). Validity is `findMergeHosts` (the item 95 merge rule) plus the "not drastic" rule: the
// host's new window stays inside the host request's own declared flexibility.

import { compareUnitsByPriority, runGreedy, type Placed, type PlacedSingle, type Unit } from './greedy';
import { findMergeHosts, type HostRide } from './merge';
import { sum } from './seatFit';
import type { NormalizedRequest } from './slots';
import type { CarTimeline } from './timeline';
import type { Car, LegSide, SolverInput } from './types';

export interface PoolingResult {
  placed: Placed[];
  unmetUnits: Unit[];
  /** requests seated as a passenger of another ride */
  pooledRequestIds: Set<string>;
}

const rideIdOf = (nr: NormalizedRequest): string => `ride:${nr.id}`;

function isRoundTripSingle(nr: NormalizedRequest): boolean {
  return nr.legs[0]?.side === 'both' && nr.tripType === 'round_trip' && !nr.isPassengerOnly && !nr.request.seriesId;
}

function isGuestCandidate(p: PlacedSingle): boolean {
  return isRoundTripSingle(p.nr) && (p.guests?.length ?? 0) === 0;
}

function isHostCandidate(p: PlacedSingle, cars: Map<string, Car>): boolean {
  return (
    isRoundTripSingle(p.nr) &&
    p.nr.request.canDrive !== false &&
    cars.get(p.carId)?.type === 'shared'
  );
}

function hostRideOf(p: PlacedSingle): HostRide {
  const guests = p.guests ?? [];
  return {
    rideId: rideIdOf(p.nr),
    carId: p.carId,
    window: p.window,
    driverRequestId: p.nr.id,
    legSide: 'both',
    destinationId: p.nr.destinationId,
    originId: p.nr.originId,
    requestDestinationId: p.nr.destinationId,
    passengers: sum(p.nr.passengers, ...guests.map((g) => g.passengers)),
    luggageCount: (p.nr.luggage ? 1 : 0) + guests.filter((g) => g.luggage).length,
    guestCount: guests.length,
    isFixed: false,
    isTemporary: false,
  };
}

/**
 * Tries to seat `guest` (placed on `guestPlaced`, or unmet when undefined) in another placed ride.
 * On success the host entry, the timelines and `placed` are updated (the caller drops an unmet guest).
 */
function tryPool(
  guest: NormalizedRequest,
  guestPlaced: PlacedSingle | undefined,
  placed: Placed[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  carsMap: Map<string, Car>,
  /** 'both' = a whole round trip (pooling); 'out' / 'return' = one leg rides along (REQ item 136 b). */
  leg: LegSide = 'both',
): boolean {
  const hostPlaced = placed
    .filter((h): h is PlacedSingle => h.kind === 'single')
    .filter((h) => h !== guestPlaced && isHostCandidate(h, carsMap) && h.nr.dayIndex === guest.dayIndex);
  if (hostPlaced.length === 0) return false;
  const hostNrByRide = new Map(hostPlaced.map((h) => [rideIdOf(h.nr), h.nr]));
  const hostByRide = new Map(hostPlaced.map((h) => [rideIdOf(h.nr), h]));

  const guestTl = guestPlaced ? timelines.get(guestPlaced.carId) : undefined;
  const guestBlock = guestPlaced ? guestTl?.remove(rideIdOf(guest)) : undefined;
  const restoreGuest = () => {
    if (guestBlock) guestTl?.restore(guestBlock);
  };
  const candidates = findMergeHosts({
    guest,
    leg,
    hosts: hostPlaced.map(hostRideOf),
    destinations: input.destinations,
    config: input.config,
    cars: carsMap,
    hostDriverRequests: hostNrByRide,
    hostTimelines: timelines,
    homeLocationId: input.homeLocationId,
    travel: input.travel,
  });
  // not drastic: the host's new window stays inside its own declared flexibility, and inside its day
  const best = candidates.find((c) => {
    const h = hostByRide.get(c.hostRideId);
    return (
      !!h &&
      // a ride-along guest never moves a host that already carries guests (their boarding/alighting times hold)
      (leg === 'both' || (h.guests?.length ?? 0) === 0 || (c.window.start === h.window.start && c.window.end === h.window.end)) &&
      c.window.start >= h.nr.flexDep[0] &&
      c.window.end <= h.nr.flexRet[1] &&
      c.window.start >= h.nr.dayWindow.start &&
      c.window.end <= h.nr.dayWindow.end
    );
  });
  const hostPl = best ? hostByRide.get(best.hostRideId) : undefined;
  if (!best || !hostPl) {
    restoreGuest();
    return false;
  }
  const hostTl = timelines.get(hostPl.carId);
  const hostBlock = hostTl?.remove(rideIdOf(hostPl.nr));
  if (hostTl && hostBlock) {
    if (!hostTl.isFree(best.window, hostBlock.startLocationId, hostBlock.relayPairId, hostBlock.endLocationId)) {
      hostTl.restore(hostBlock);
      restoreGuest();
      return false;
    }
    hostTl.add({ ...hostBlock, window: best.window });
  }
  hostPl.window = best.window;
  hostPl.shift = {
    departureMin: (best.window.start - hostPl.nr.window.start) * 15,
    returnMin: (best.window.end - hostPl.nr.window.end) * 15,
  };
  hostPl.balancedMileage = false;
  hostPl.guests = [...(hostPl.guests ?? []), guest];
  if (leg !== 'both') hostPl.guestLegs = { ...(hostPl.guestLegs ?? {}), [guest.id]: leg };
  if (guestPlaced) placed.splice(placed.indexOf(guestPlaced), 1);
  return true;
}

const unitPriority = (nr: NormalizedRequest, scores: Map<string, { total: number }>): Unit => ({
  kind: 'single',
  id: nr.id,
  score: scores.get(nr.id)?.total ?? 0,
  submittedAtMs: nr.request.submittedAtMs,
  single: nr,
});

/**
 * One pooling round; returns how many guests were seated. Mutates `placed`, `unmet`, `timelines` and host
 * entries. Placed guests come first (lowest priority first); then still-unmet round trips (highest priority
 * first, they compete for seats) take a seat directly instead of waiting for a car or a merge suggestion.
 */
function poolRound(
  placed: Placed[],
  unmet: Unit[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  scores: Map<string, { total: number }>,
  carsMap: Map<string, Car>,
  pooled: Set<string>,
): number {
  const guestsOrder = placed
    .filter((p): p is PlacedSingle => p.kind === 'single')
    .filter((p) => isGuestCandidate(p) && !pooled.has(p.nr.id))
    // lowest priority first: the higher-priority request keeps its own car and drives
    .sort((a, b) => compareUnitsByPriority(unitPriority(b.nr, scores), unitPriority(a.nr, scores)));

  let count = 0;
  for (const guestPlaced of guestsOrder) {
    // may have become a host earlier in this round
    if ((guestPlaced.guests?.length ?? 0) > 0 || !placed.includes(guestPlaced)) continue;
    if (tryPool(guestPlaced.nr, guestPlaced, placed, timelines, input, carsMap)) {
      pooled.add(guestPlaced.nr.id);
      count++;
    }
  }
  const unmetOrder = unmet
    .filter((u) => u.kind === 'single' && !!u.single && isRoundTripSingle(u.single) && !pooled.has(u.single.id))
    .sort(compareUnitsByPriority);
  for (const unit of unmetOrder) {
    if (!unit.single) continue;
    if (tryPool(unit.single, undefined, placed, timelines, input, carsMap)) {
      pooled.add(unit.single.id);
      unmet.splice(unmet.indexOf(unit), 1);
      count++;
    }
  }
  return count;
}

/**
 * Pooling pass + retry of the unmet units on the freed capacity, until nothing changes.
 * `unmetUnits` are the units still unmet after greedy + improve.
 */
export function runPooling(
  placed: Placed[],
  unmetUnits: Unit[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  scores: Map<string, { total: number }>,
  carsMap: Map<string, Car>,
): PoolingResult {
  const pooledRequestIds = new Set<string>();
  let current = [...placed];
  let unmet = [...unmetUnits];
  for (;;) {
    const pooledNow = poolRound(current, unmet, timelines, input, scores, carsMap, pooledRequestIds);
    if (pooledNow === 0) break;
    // the freed capacity may serve a still-unmet unit; whatever it places is a candidate in the next round
    if (unmet.length > 0) {
      const retry = runGreedy(unmet, timelines, input);
      current = [...current, ...retry.placed];
      unmet = retry.unmetUnits;
    }
  }
  return { placed: current, unmetUnits: unmet, pooledRequestIds };
}

/**
 * REQ item 136 (b) (docs/SOLVER.md §3.6.6): a drop-off leg (a `#out`/`#ret` half, a one-leg drop-off, or a
 * passenger-only one-way leg) first tries to ride as a passenger in a placed ride passing by, before it can become a
 * chauffeur ride. Same validity as pooling (`findMergeHosts` with the leg + the "not drastic" host rule); priority
 * order (score, submission, id), so the higher-priority leg takes the seat first. Returns the ids seated. Mutates
 * `placed` host entries and `timelines` (a host's window may grow by the detour); the legs have no block of their own.
 */
export function runRideAlong(
  candidates: NormalizedRequest[],
  placed: Placed[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  scores: Map<string, { total: number }>,
  carsMap: Map<string, Car>,
): Set<string> {
  const seated = new Set<string>();
  const order = [...candidates]
    .filter((nr) => nr.legs[0]?.side === 'out' || nr.legs[0]?.side === 'return')
    .sort((a, b) => compareUnitsByPriority(unitPriority(a, scores), unitPriority(b, scores)));
  for (const nr of order) {
    if (seated.has(nr.id)) continue;
    const side = nr.legs[0]?.side === 'return' ? 'return' : 'out';
    if (tryPool(nr, undefined, placed, timelines, input, carsMap, side)) seated.add(nr.id);
  }
  return seated;
}

/** Seats one request (a whole round trip when `leg` is 'both', else one leg) as a guest of a placed ride, if one fits. */
export function seatAsGuest(
  guest: NormalizedRequest,
  leg: LegSide,
  placed: Placed[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  carsMap: Map<string, Car>,
): boolean {
  return tryPool(guest, undefined, placed, timelines, input, carsMap, leg);
}
