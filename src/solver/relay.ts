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
import { requestDestName } from './names';
import type { NormalizedRequest } from './slots';
import { byId, dayBoundsForSlot, formatSlotTime, minutesToSlots, travelSlotsFor, withinRequestDay } from './slots';
import type { CarTimeline } from './timeline';
import type { Assignment, Car, SolverInput, Window } from './types';
import { chauffeurLoad, fits, luggageFits } from './seatFit';
import { chauffeurCandidates, type ChauffeurCandidate } from './travel';

export interface RelayPair {
  id: string;
  outRequestId: string;
  returnRequestId: string;
  /** both legs' shared origin (REQUIREMENTS §13.93) — the car starts and ends here */
  originId: string;
  destinationId: string;
  outWindow: Window;
  returnWindow: Window;
  idleSlots: number;
  shiftCost: number; // minutes
}

// A `tripType === 'one_way'` request (REQUIREMENTS §13.93) never enters pairing —
// it has no pairing obligation and is placed directly as a single unit by
// greedy.ts instead (defense in depth: index.ts also keeps it out of the
// `relayEligible` batch passed in here).
function isRelayOut(nr: NormalizedRequest): boolean {
  const leg = nr.legs[0];
  return leg?.side === 'out' && leg.preferredMode === 'relay' && nr.tripType !== 'one_way';
}
function isRelayReturn(nr: NormalizedRequest): boolean {
  const leg = nr.legs[0];
  return leg?.side === 'return' && leg.preferredMode === 'relay' && nr.tripType !== 'one_way';
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
  // A free-text destination is no place a car can wait at (REQ §13.58): never a relay pair.
  if (out.request.destinationIsFreeText || ret.request.destinationIsFreeText) return null;
  // REQUIREMENTS §13.93: both legs of a relay pair must share the same
  // origin — the car leaves from and returns to one place. Every legacy
  // (home-origin) request has the same originId (home), so this is a no-op
  // for every existing scenario.
  if (out.originId !== ret.originId) return null;
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

export function pairRelays(requests: NormalizedRequest[], cars: Car[], others: NormalizedRequest[] = []): PairRelaysResult {
  const outs = requests.filter(isRelayOut);
  const rets = requests.filter(isRelayReturn);

  const candidates: Candidate[] = [];
  for (const o of outs) {
    for (const r of rets) {
      const c = tryPair(o, r, cars);
      if (c) candidates.push(c);
    }
  }

  // REQUIREMENTS §13.95 (H2): the two halves of one drop-off-with-pickup (`splitFrom`) connect into one
  // relay pair on one car — the requester (or a driving companion) drives both — before
  // any cross pairing with another member's leg.
  const isOwn = (c: Candidate): boolean => c.out.request.splitFrom !== undefined && c.out.request.splitFrom === c.ret.request.splitFrom;
  // REQUIREMENTS §13.103a: the connected own pair keeps the car waiting at the destination, so it is
  // offered only when the wait is not contested: fewer other requests overlap the wait window than
  // there are shared cars. Otherwise the two legs stay separate (chauffeur legs, car returns between).
  const sharedCars = cars.filter((c) => c.type === 'shared').length;
  const contested = (c: Candidate): boolean => {
    const waitStart = c.outWindow.end;
    const waitEnd = c.returnWindow.start;
    const demand = new Set<string>();
    for (const nr of [...requests, ...others]) {
      if (nr.request.splitFrom !== undefined && nr.request.splitFrom === c.out.request.splitFrom) continue;
      if (nr.id === c.out.id || nr.id === c.ret.id) continue;
      if (nr.window.start < waitEnd && waitStart < nr.window.end) demand.add(nr.request.splitFrom ?? nr.id);
    }
    return demand.size >= Math.max(1, sharedCars);
  };
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (c && isOwn(c) && contested(c)) candidates.splice(i, 1);
  }
  const own = (c: Candidate): number => (isOwn(c) ? 0 : 1);
  candidates.sort((a, b) => {
    if (own(a) !== own(b)) return own(a) - own(b);
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
      originId: c.out.originId,
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

/**
 * Places an unpaired relay candidate as a standalone **chauffeur** ride
 * (REQUIREMENTS §13.88, rule made precise 2026-09-16; docs/SOLVER.md §3.6.1a
 * — supersedes the removed `healLoneRelayLegs`/`PLACED_RELAY_SOLO`
 * relocation-pair design). Owner: "if nobody can drive back, my leg is a
 * chauffeur ride" — the car wraps around the requester's own leg, originId ===
 * destinationId (never left waiting at the destination), around whichever end
 * of the leg the car is actually free at (REQUIREMENTS §13.93, owner
 * follow-up 2026-10-04, ORIGINS_PLAN §3, `chauffeurCandidates()`): the leg's
 * own origin for a drop-off, or its destination for a pickup (e.g. "pick me
 * up from Harish": origin Harish, destination Givat Haviva, the car is at
 * Givat Haviva). A `return` leg keeps the legacy single formula, anchored at
 * the request's own origin. The requester rides as a passenger and the ride
 * waits for a volunteer driver like any other needs-driver ride
 * (`stats.needsDriver`). There is no relocation ride and no `pairedRideId`.
 * Mutates `timelines` (adds the one block) exactly like the greedy pass does.
 *
 * Simplification (documented, in the style of docs/SOLVER.md §9.1): only the
 * leg's own preferred window(s) are tried, on the first shared car (by id)
 * that has room for the *whole* chauffeur window and fits `chauffeurLoad` —
 * no flexibility search. A leg no car can take this way (at either end) is
 * left for the ordinary `UNMET_NO_RELAY_PARTNER` suggestion ladder unchanged
 * (§3.11 item 5, whose `chauffeur` suggestion tries the identical candidates).
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
    // The chauffeur window must stay on the leg's own scheduling day (mirrors
    // the day-boundary care the superseded relocation design took via
    // dayEndSlot/startSlot) — no car can ever fix a window that spills past
    // midnight, so this is checked once, independent of car choice.
    const day = dayBoundsForSlot(input.week.days, point);
    const load = chauffeurLoad(nr.passengers);
    const luggageCount = nr.luggage ? 1 : 0;
    // REQUIREMENTS §13.93 (owner follow-up 2026-10-04, ORIGINS_PLAN §3): an
    // `out` leg A -> B tries the car at A (drop-off) and at B (pickup, e.g.
    // "pick me up from Harish") in that order; a `return` leg keeps the
    // legacy single formula anchored at the request's own origin. A no-op
    // generalization for every home-origin request (its only candidate is
    // still the drop-off one, anchored at home). Multi-stop rides
    // (REQUIREMENTS §13.93 "Multi-stop rides"): `nr.travelSlots` is already
    // the leg's own route duration (stops included, from normalize()); the
    // chauffeur's empty repositioning drive never revisits the stops, so it
    // uses the plain point-to-point `directSlots` instead.
    const directSlots = travelSlotsFor(input, nr.originId, nr.destinationId);
    const candidates = chauffeurCandidates(side, point, nr.travelSlots, directSlots, dwellSlots, nr.originId, nr.destinationId);

    let carId: string | null = null;
    let chosen: ChauffeurCandidate | null = null;
    for (const candidate of candidates) {
      if (candidate.window.start < day.startSlot || candidate.window.end > day.endSlot) continue;
      for (const car of sharedCars) {
        if (!fits(car, load) || !luggageFits(car, luggageCount)) continue;
        const tl = timelines.get(car.id);
        if (!tl || !tl.isFree(candidate.window, candidate.carOriginId)) continue;
        carId = car.id;
        chosen = candidate;
        break;
      }
      if (carId) break;
    }
    if (!carId || !chosen) continue;
    const window = chosen.window;
    const carOrigin = chosen.carOriginId;

    const tl = timelines.get(carId);
    if (!tl) continue;
    const car = carsById.get(carId);
    const rideId = `ride:${nr.id}`;
    tl.add({ rideId, window, startLocationId: carOrigin, endLocationId: carOrigin, overnightAck: false });

    const reasonCode = cause === 'noDriver' ? 'PLACED_NEEDS_DRIVER' : 'PLACED_CHAUFFEUR_NO_RETURNER';
    const text = cause === 'noDriver'
      ? reason('PLACED_NEEDS_DRIVER', { car: car?.name ?? '' })
      : reason('PLACED_CHAUFFEUR_NO_RETURNER', {
          car: car?.name ?? '',
          dest: requestDestName(input, nr.request),
          dep: formatSlotTime(window.start, day),
          ret: formatSlotTime(window.end, day),
        });

    healed.push({
      rideId,
      carId,
      window,
      originId: carOrigin,
      destinationId: carOrigin,
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
