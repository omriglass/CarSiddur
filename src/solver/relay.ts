// src/solver/relay.ts
//
// Relay pairing (docs/SOLVER.md §3.6.1). Matches relay out-legs with relay
// back-legs to the same destination with compatible times (after choosing
// the minimal shift of each inside its own declared flexibility) and seats;
// runs before scoring so peopleServed can credit both legs of a pair without
// circularity. Simplification (recorded in docs/SOLVER.md): this module
// pairs one-way relay requests only; a needsCarAtDestination = false round
// trip is tried as a single 'keep' unit in the main greedy pass and, if
// unmet, its legs are resolved independently (including the relay+relay
// self-pair) by splitLegs.ts.
//
// Eligibility (REQUIREMENTS §13.88, rule made precise 2026-09-16): a leg is a
// *relay candidate* — and therefore enters `pairRelays` below — whenever it
// has an eligible driver on board (`slots.ts`'s `resolveOneWayMode`, driven by
// `hasEligibleDriver`); pairing itself never re-checks who drives, only
// destination/time/seats. What used to be "always relay for a driver, always
// passenger for a non-driver" is now "pairing decides the mode, not the
// member": a paired candidate is a real `relay` leg; an unpaired one becomes a
// standalone `chauffeur` placement (`chauffeurUnpairedRelayLegs` below), never
// left waiting at the destination.

import { reason } from './reasons';
import type { NormalizedRequest } from './slots';
import { byId, dayBoundsForSlot, formatSlotTime, minutesToSlots, withinRequestDay } from './slots';
import type { CarTimeline } from './timeline';
import type { Assignment, Car, SolverInput, Window } from './types';
import { chauffeurLoad, fits, luggageFits } from './seatFit';

export interface RelayPair {
  id: string;
  outRequestId: string;
  returnRequestId: string;
  destinationId: string;
  outWindow: Window;
  returnWindow: Window;
  idleSlots: number;
  shiftCost: number; // minutes
}

function isRelayOut(nr: NormalizedRequest): boolean {
  const leg = nr.legs[0];
  return leg?.side === 'out' && leg.preferredMode === 'relay';
}
function isRelayReturn(nr: NormalizedRequest): boolean {
  const leg = nr.legs[0];
  return leg?.side === 'return' && leg.preferredMode === 'relay';
}

export interface Candidate {
  out: NormalizedRequest;
  ret: NormalizedRequest;
  outWindow: Window;
  returnWindow: Window;
  idleSlots: number;
  shiftCost: number;
}

export function tryPair(out: NormalizedRequest, ret: NormalizedRequest, cars: Car[]): Candidate | null {
  if (out.destinationId !== ret.destinationId) return null;
  if (out.dayIndex !== ret.dayIndex) return null;

  // Each leg's own passengers must fit some shared car (checked per leg, §3.3/§3.6.1).
  const sharedCars = cars.filter((c) => c.type === 'shared');
  if (!sharedCars.some((c) => fits(c, out.passengers))) return null;
  if (!sharedCars.some((c) => fits(c, ret.passengers))) return null;

  const outEnd = out.window.end;
  const retStart = ret.window.start;

  if (outEnd <= retStart) {
    if (!withinRequestDay(out, out.window) || !withinRequestDay(ret, ret.window)) return null;
    return {
      out,
      ret,
      outWindow: out.window,
      returnWindow: ret.window,
      idleSlots: retStart - outEnd,
      shiftCost: 0,
    };
  }

  const needed = outEnd - retStart;
  const availableLaterForRet = ret.flexRet[1] - ret.window.end;
  const availableEarlierForOut = out.window.start - out.flexDep[0];
  const totalAvailable = Math.max(0, availableLaterForRet) + Math.max(0, availableEarlierForOut);
  if (totalAvailable < needed) return null;

  // Deterministic split: shift the return leg later first, then the out leg earlier.
  const retShift = Math.min(needed, Math.max(0, availableLaterForRet));
  const outShift = needed - retShift;

  const newRetEnd = ret.window.end + retShift;
  const newRetStart = ret.window.start + retShift;
  const newOutStart = out.window.start - outShift;
  const newOutEnd = out.window.end - outShift;
  if (!withinRequestDay(out, { start: newOutStart, end: newOutEnd }) || !withinRequestDay(ret, { start: newRetStart, end: newRetEnd })) return null;

  return {
    out,
    ret,
    outWindow: { start: newOutStart, end: newOutEnd },
    returnWindow: { start: newRetStart, end: newRetEnd },
    idleSlots: 0,
    shiftCost: (retShift + outShift) * 15,
  };
}

export interface PairRelaysResult {
  pairs: RelayPair[];
  unpaired: NormalizedRequest[];
}

export function pairRelays(requests: NormalizedRequest[], cars: Car[]): PairRelaysResult {
  const outs = requests.filter(isRelayOut);
  const rets = requests.filter(isRelayReturn);

  const candidates: Candidate[] = [];
  for (const o of outs) {
    for (const r of rets) {
      const c = tryPair(o, r, cars);
      if (c) candidates.push(c);
    }
  }

  candidates.sort((a, b) => {
    const rankA = a.idleSlots + a.shiftCost;
    const rankB = b.idleSlots + b.shiftCost;
    if (rankA !== rankB) return rankA - rankB;
    if (a.out.id !== b.out.id) return byId({ id: a.out.id }, { id: b.out.id });
    return byId({ id: a.ret.id }, { id: b.ret.id });
  });

  const usedOut = new Set<string>();
  const usedRet = new Set<string>();
  const pairs: RelayPair[] = [];
  for (const c of candidates) {
    if (usedOut.has(c.out.id) || usedRet.has(c.ret.id)) continue;
    usedOut.add(c.out.id);
    usedRet.add(c.ret.id);
    pairs.push({
      id: `pair:${c.out.id}:${c.ret.id}`,
      outRequestId: c.out.id,
      returnRequestId: c.ret.id,
      destinationId: c.out.destinationId,
      outWindow: c.outWindow,
      returnWindow: c.returnWindow,
      idleSlots: c.idleSlots,
      shiftCost: c.shiftCost,
    });
  }

  const unpaired = requests.filter((nr) => (isRelayOut(nr) && !usedOut.has(nr.id)) || (isRelayReturn(nr) && !usedRet.has(nr.id)));

  return { pairs, unpaired };
}

export interface ChauffeurHealResult {
  /** the standalone chauffeur ride created for each healed leg */
  healed: Assignment[];
  /** ids of requests that were healed (no longer unmet) */
  healedIds: Set<string>;
}

/** Car occupancy window of a standalone chauffeur ride (docs/SOLVER.md §1.2): a
 *  home round trip wrapped around the requester's one-way leg — `[D, D + 2·travel
 *  + dwell)` for an out leg (drop-off), `[R − 2·travel − dwell, R)` for a return
 *  leg (pick-up). Mirrors `suggestions.ts`'s (private) `chauffeurWindow`. */
function chauffeurWindow(side: 'out' | 'return', point: number, travelSlots: number, dwellSlots: number): Window {
  const total = travelSlots * 2 + dwellSlots;
  return side === 'out' ? { start: point, end: point + total } : { start: point - total, end: point };
}

/**
 * Places an unpaired relay candidate as a standalone **chauffeur** ride
 * (REQUIREMENTS §13.88, rule made precise 2026-09-16; docs/SOLVER.md §3.6.1a
 * — supersedes the removed `healLoneRelayLegs`/`PLACED_RELAY_SOLO`
 * relocation-pair design). Owner: "if nobody can drive back, my leg is a
 * chauffeur ride" — the car goes home → X → home (or home → X → home to
 * fetch, for a return leg) around the requester's own leg; the requester
 * rides as a passenger and the ride waits for a volunteer driver like any
 * other needs-driver ride (`stats.needsDriver`). The car is **never** left
 * waiting at X — there is no relocation ride and no `pairedRideId`. Mutates
 * `timelines` (adds the one block) exactly like the greedy pass does.
 *
 * Simplification (documented, in the style of docs/SOLVER.md §9.1): only the
 * leg's own preferred window is tried, on the first shared car (by id) that
 * has room for the *whole* chauffeur window and fits `chauffeurLoad` — no
 * flexibility search. A leg no car can take this way is left for the ordinary
 * `UNMET_NO_RELAY_PARTNER` suggestion ladder unchanged (§3.11 item 5, whose
 * `chauffeur` suggestion tries the identical window again).
 */
export function chauffeurUnpairedRelayLegs(
  unpaired: NormalizedRequest[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  carsById: Map<string, Car>,
  scores: Map<string, { total: number }>,
  /** 'noReturner' (default): an unpaired relay candidate; 'noDriver': a lone one-way leg with no
   *  eligible driver on board (REQUIREMENTS §13.88, owner 2026-09-24 — same chauffeur ride the SQL
   *  healing creates, waiting for a volunteer driver). */
  cause: 'noReturner' | 'noDriver' = 'noReturner',
): ChauffeurHealResult {
  const healed: Assignment[] = [];
  const healedIds = new Set<string>();
  const dwellSlots = minutesToSlots(input.config.chauffeurDwellMinutes);
  const home = input.homeLocationId;
  const sharedCars = input.cars.filter((c) => c.type === 'shared').sort((a, b) => byId({ id: a.id }, { id: b.id }));

  const sorted = [...unpaired].sort((a, b) => {
    const sa = scores.get(a.id)?.total ?? 0;
    const sb = scores.get(b.id)?.total ?? 0;
    if (sa !== sb) return sb - sa;
    if (a.request.submittedAtMs !== b.request.submittedAtMs) return a.request.submittedAtMs - b.request.submittedAtMs;
    return byId(a, b);
  });

  for (const nr of sorted) {
    const leg = nr.legs[0];
    if (!leg || leg.side === 'both') continue; // defensive: unpaired only ever holds one-way relay legs
    const side: 'out' | 'return' = leg.side === 'out' ? 'out' : 'return';
    const point = side === 'out' ? leg.window.start : leg.window.end;
    const window = chauffeurWindow(side, point, nr.travelSlots, dwellSlots);
    // The chauffeur window must stay on the leg's own scheduling day (mirrors
    // the day-boundary care the superseded relocation design took via
    // dayEndSlot/startSlot) — no car can ever fix a window that spills past
    // midnight, so this is checked once, independent of car choice.
    const day = dayBoundsForSlot(input.week.days, point);
    if (window.start < day.startSlot || window.end > day.endSlot) continue;
    const load = chauffeurLoad(nr.passengers);
    const luggageCount = nr.luggage ? 1 : 0;

    let carId: string | null = null;
    for (const car of sharedCars) {
      if (!fits(car, load) || !luggageFits(car, luggageCount)) continue;
      const tl = timelines.get(car.id);
      if (!tl || !tl.isFree(window, home)) continue;
      carId = car.id;
      break;
    }
    if (!carId) continue;

    const tl = timelines.get(carId);
    if (!tl) continue;
    const car = carsById.get(carId);
    const rideId = `ride:${nr.id}`;
    tl.add({ rideId, window, startLocationId: home, endLocationId: home, overnightAck: false });

    const reasonCode = cause === 'noDriver' ? 'PLACED_NEEDS_DRIVER' : 'PLACED_CHAUFFEUR_NO_RETURNER';
    const text = cause === 'noDriver'
      ? reason('PLACED_NEEDS_DRIVER', { car: car?.name ?? carId })
      : reason('PLACED_CHAUFFEUR_NO_RETURNER', {
          car: car?.name ?? carId,
          dest: nr.destinationId,
          dep: formatSlotTime(window.start, day),
          ret: formatSlotTime(window.end, day),
        });

    healed.push({
      rideId,
      carId,
      window,
      originId: home,
      destinationId: home,
      driverRequestId: undefined,
      driverMemberId: undefined,
      legs: [
        {
          requestId: nr.id,
          leg: leg.side,
          carMode: 'chauffeur',
          originId: leg.originId,
          destinationId: leg.destinationId,
          role: 'passenger',
        },
      ],
      servedRequestIds: [nr.id],
      passengers: nr.passengers,
      luggageCount,
      shift: { departureMin: 0, returnMin: 0 },
      source: 'solver',
      reasonCode,
      reason: text,
    });

    healedIds.add(nr.id);
  }

  return { healed, healedIds };
}
