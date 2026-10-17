// src/solver/driverFirst.ts
//
// A driverless ride never takes a car a driver needs (REQUIREMENTS item 136 b, docs/SOLVER.md §3.6.7). After the
// chauffeur / needs-driver healing, a still-unmet request whose requester (or a driving companion) drives may
// take the car of solver-made driverless rides: chauffeur wraps and needs-driver round trips, never a fixed ride.
// Bounded: the candidates are the driverless rides overlapping the request's envelope (at most MAX_EVICTABLE,
// by ride id), one eviction first, then two; the first combination that lets the request be placed wins. The
// evicted legs go back to unmet (the caller gives them their normal suggestions and `UNMET_CAR_TO_DRIVER`).
// Deterministic: unmet requests in priority order, candidates and combinations in id order.

import { compareUnitsByPriority, runGreedy, type Placed, type PlacedSingle, type Unit } from './greedy';
import { eligibleDriverMemberId, minutesToSlots } from './slots';
import type { Block, CarTimeline } from './timeline';
import type { Assignment, SolverInput, Window } from './types';

export const MAX_EVICTABLE = 8;
export const MAX_EVICTED_PER_REQUEST = 2;

interface Evictable {
  rideId: string;
  carId: string;
  window: Window;
  requestIds: string[];
}

export interface DriverFirstResult {
  /** the driver requests placed on the freed cars */
  newPlaced: Placed[];
  /** units that were placed (to drop from the unmet pool) */
  placedUnitIds: Set<string>;
  /** ride ids taken out of the plan */
  removedRideIds: Set<string>;
  /** evicted request id -> request id of the driver who took the car */
  evicted: Map<string, string>;
}

function isDriverlessSingle(p: Placed): p is PlacedSingle {
  return p.kind === 'single' && p.nr.request.canDrive === false && (p.guests?.length ?? 0) === 0;
}

export function evictDriverlessForDrivers(
  unmetUnits: Unit[],
  placed: Placed[],
  chauffeurRides: Assignment[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
): DriverFirstResult {
  const result: DriverFirstResult = { newPlaced: [], placedUnitIds: new Set(), removedRideIds: new Set(), evicted: new Map() };
  const evictables: Evictable[] = [];
  for (const a of chauffeurRides) {
    if (a.source !== 'solver' || a.driverRequestId || a.driverMemberId) continue;
    evictables.push({ rideId: a.rideId, carId: a.carId, window: a.window, requestIds: [...a.servedRequestIds] });
  }
  for (const p of placed) {
    if (!isDriverlessSingle(p)) continue;
    evictables.push({ rideId: `ride:${p.nr.id}`, carId: p.carId, window: p.window, requestIds: [p.nr.id] });
  }
  if (evictables.length === 0) return result;
  evictables.sort((a, b) => (a.rideId < b.rideId ? -1 : a.rideId > b.rideId ? 1 : 0));

  const buffer = minutesToSlots(input.config.bufferMinutes);
  const wanting = unmetUnits
    .filter((u) => u.kind === 'single' && !!u.single && !u.single.isPassengerOnly && eligibleDriverMemberId(u.single.request) !== undefined)
    .sort(compareUnitsByPriority);

  for (const unit of wanting) {
    const nr = unit.single;
    if (!nr) continue;
    const envStart = nr.flexDep[0] - buffer;
    const envEnd = (nr.legs[0]?.side === 'both' ? nr.flexRet[1] : nr.flexDep[1] + (nr.window.end - nr.window.start)) + buffer;
    const candidates = evictables
      .filter((e) => !result.removedRideIds.has(e.rideId) && e.window.start < envEnd && envStart < e.window.end)
      .slice(0, MAX_EVICTABLE);
    if (candidates.length === 0) continue;
    const combos: Evictable[][] = candidates
      .map((c) => [c])
      .sort((a, b) => (a[0] as Evictable).requestIds.length - (b[0] as Evictable).requestIds.length);
    if (MAX_EVICTED_PER_REQUEST >= 2) {
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) combos.push([candidates[i] as Evictable, candidates[j] as Evictable]);
      }
    }
    for (const combo of combos) {
      const removed: { e: Evictable; block: Block }[] = [];
      for (const e of combo) {
        const block = timelines.get(e.carId)?.remove(e.rideId);
        if (block) removed.push({ e, block });
      }
      const retry = runGreedy([unit], timelines, input);
      if (retry.placed.length > 0) {
        result.newPlaced.push(...retry.placed);
        result.placedUnitIds.add(unit.id);
        for (const { e } of removed) {
          result.removedRideIds.add(e.rideId);
          for (const id of e.requestIds) result.evicted.set(id, nr.id);
        }
        break;
      }
      for (const { e, block } of removed) timelines.get(e.carId)?.restore(block);
    }
  }
  return result;
}
