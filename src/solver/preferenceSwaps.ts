// src/solver/preferenceSwaps.ts
//
// REQUIREMENTS item 136 (f), docs/SOLVER.md §3.6.5: preferred cars are answered in a FIXING STAGE. A
// preferred car never outranks a requirement or another request's placement, so this pass runs on the
// finished plan (after greedy, improve, series repair and pooling) and only exchanges cars between
// rides that are already placed, window-preserving:
//
//   * candidate: a placed solver single whose request prefers a shared car P and sits on another car C;
//   * move it onto P when P is free for its window (the single move), else swap it with the placed
//     singles that overlap its window (incl. buffer) on P — they move to C with their own windows;
//   * accepted only when the number of satisfied preferences strictly increases, every moved ride still
//     seats its people (a pooled host carries its guests) and luggage, every timeline accepts the new
//     blocks (overlap, buffer, maintenance, location chain, the item 136 c week-end rule) and no chain
//     break is newly created. Otherwise every timeline is rolled back.
//
// Never moved: fixed rides, relay pairs, multi-day series, anything that is not a placed solver single
// (a pair/series/fixed ride overlapping the preferred car makes that car unavailable). No window ever
// changes, so nobody leaves their declared flexibility. Pure and deterministic: candidates run by the
// preferring request's score (desc) then id; each accepted swap strictly raises the satisfied count, so
// the loop is bounded.

import { addsChainBreak, chainBreakIds } from './improve';
import { fits, luggageFits, sum } from './seatFit';
import { minutesToSlots } from './slots';
import type { Block, CarTimeline } from './timeline';
import type { Car, SolverInput } from './types';
import type { Placed, PlacedSingle } from './greedy';

/** Most rides moved off the preferred car for one candidate (itself not counted). */
export const MAX_SWAP_PARTNERS = 2;

const rideIdOf = (p: PlacedSingle): string => `ride:${p.nr.id}`;
const byIdAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const satisfied = (p: PlacedSingle, carId = p.carId): number =>
  p.nr.request.preferredCarId !== undefined && p.nr.request.preferredCarId === carId ? 1 : 0;

function loadOf(p: PlacedSingle): { passengers: ReturnType<typeof sum>; luggage: number } {
  const guests = p.guests ?? [];
  return {
    passengers: sum(p.nr.passengers, ...guests.map((g) => g.passengers)),
    luggage: (p.nr.luggage ? 1 : 0) + guests.filter((g) => g.luggage).length,
  };
}

function seatsAll(p: PlacedSingle, car: Car): boolean {
  const load = loadOf(p);
  return fits(car, load.passengers) && luggageFits(car, load.luggage);
}

export interface PreferenceSwapResult {
  swaps: number;
}

export function runPreferenceSwaps(
  placed: Placed[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  scores: Map<string, { total: number }>,
  carsMap: Map<string, Car>,
): PreferenceSwapResult {
  const singles = placed.filter((p): p is PlacedSingle => p.kind === 'single');
  const byRide = new Map(singles.map((p) => [rideIdOf(p), p]));
  const bufferSlots = minutesToSlots(input.config.bufferMinutes);
  const scoreOf = (p: PlacedSingle): number => scores.get(p.nr.id)?.total ?? 0;
  let swaps = 0;

  const tryCandidate = (r: PlacedSingle): boolean => {
    const prefId = r.nr.request.preferredCarId;
    if (!prefId || r.carId === prefId) return false;
    const pCar = carsMap.get(prefId);
    const cCar = carsMap.get(r.carId);
    const pTl = timelines.get(prefId);
    const cTl = timelines.get(r.carId);
    if (!pCar || !cCar || !pTl || !cTl || pCar.type !== 'shared' || cCar.type !== 'shared') return false;
    if (!seatsAll(r, pCar)) return false;

    // the rides on P that overlap R's window (incl. buffer on both sides): all must be movable placed singles
    const overlapping = pTl
      .allBlocks()
      .filter((b) => b.window.start < r.window.end + bufferSlots && r.window.start < b.window.end + bufferSlots);
    const partners: PlacedSingle[] = [];
    for (const b of overlapping) {
      const q = byRide.get(b.rideId);
      if (!q || q.carId !== prefId || q.window.start !== b.window.start || q.window.end !== b.window.end) return false;
      partners.push(q);
    }
    if (partners.length > MAX_SWAP_PARTNERS) return false;
    if (!partners.every((q) => seatsAll(q, cCar))) return false;

    const before = satisfied(r) + partners.reduce((s, q) => s + satisfied(q), 0);
    const after = satisfied(r, prefId) + partners.reduce((s, q) => s + satisfied(q, r.carId), 0);
    if (after <= before) return false;

    const cBase = chainBreakIds(cTl);
    const pBase = chainBreakIds(pTl);
    const removedR = cTl.remove(rideIdOf(r));
    const removedPartners = partners.map((q) => pTl.remove(rideIdOf(q)));
    const addedToC: string[] = [];
    let addedToP = false;
    const rollback = (): void => {
      if (addedToP) pTl.remove(rideIdOf(r));
      for (const id of addedToC) cTl.remove(id);
      for (const b of removedPartners) if (b) pTl.restore(b);
      if (removedR) cTl.restore(removedR);
    };
    if (!removedR || removedPartners.some((b) => !b)) {
      rollback();
      return false;
    }
    const canAdd = (tl: CarTimeline, b: Block): boolean =>
      !b.locationNeutral &&
      tl.isFree(b.window, b.startLocationId, b.relayPairId, b.endLocationId, { baseAtWeekEnd: true });
    const movers = (removedPartners as Block[]).slice().sort((a, b) => a.window.start - b.window.start || byIdAsc(a.rideId, b.rideId));
    for (const b of movers) {
      if (!canAdd(cTl, b)) {
        rollback();
        return false;
      }
      cTl.add(b);
      addedToC.push(b.rideId);
    }
    if (!canAdd(pTl, removedR)) {
      rollback();
      return false;
    }
    pTl.add(removedR);
    addedToP = true;
    if (addsChainBreak(cTl, cBase) || addsChainBreak(pTl, pBase)) {
      rollback();
      return false;
    }

    // commit: reasons are recomputed by `toAssignments` from the new car (mileage balance no longer explains it)
    for (const q of partners) {
      q.carId = r.carId;
      q.balancedMileage = false;
      q.preferredCar = satisfied(q) === 1;
    }
    r.carId = prefId;
    r.balancedMileage = false;
    r.preferredCar = true;
    return true;
  };

  const maxRounds = singles.length + 1;
  for (let round = 0; round < maxRounds; round++) {
    const order = singles
      .filter((p) => p.nr.request.preferredCarId !== undefined && p.carId !== p.nr.request.preferredCarId)
      .sort((a, b) => scoreOf(b) - scoreOf(a) || byIdAsc(a.nr.id, b.nr.id));
    let changed = false;
    for (const r of order) {
      if (tryCandidate(r)) {
        swaps++;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { swaps };
}
