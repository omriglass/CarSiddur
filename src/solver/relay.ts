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

import { reason } from './reasons';
import type { NormalizedRequest } from './slots';
import { byId, dayBoundsForSlot, formatSlotTime, minutesToSlots, withinRequestDay } from './slots';
import type { CarTimeline } from './timeline';
import type { Assignment, Car, SolverInput, Window } from './types';
import { fits, luggageFits } from './seatFit';

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

export interface HealResult {
  /** the solo relay leg's own ride, plus its driverless needs-driver relocation ride */
  healed: Assignment[];
  /** ids of requests that were healed (no longer unmet) */
  healedIds: Set<string>;
}

/**
 * Heals a lone (unpaired) relay leg by placing it on a free shared car and
 * auto-generating a driverless "needs a driver" relocation ride that closes
 * the day-end loop (REQUIREMENTS §13.89, docs/SOLVER.md §3.6.1a): a lone
 * relay **out** leg gets a `dest -> home` relocation at
 * `[dayEnd - travel, dayEnd)`; a lone relay **return** leg gets a symmetric
 * `home -> dest` relocation immediately before it. Mutates `timelines` (adds
 * both blocks on the chosen car) exactly like the greedy pass does.
 *
 * Simplification (documented, in the style of docs/SOLVER.md §9.1): only the
 * leg's own preferred window is tried, on the first shared car (by id) whose
 * whole pair of windows (leg + relocation) is free — no flexibility search.
 * A car that cannot fit both windows is skipped; if none can, the leg is left
 * for the ordinary UNMET_NO_RELAY_PARTNER path unchanged.
 */
export function healLoneRelayLegs(
  unpaired: NormalizedRequest[],
  timelines: Map<string, CarTimeline>,
  input: SolverInput,
  carsById: Map<string, Car>,
  scores: Map<string, { total: number }>,
): HealResult {
  const healed: Assignment[] = [];
  const healedIds = new Set<string>();
  const bufferSlots = minutesToSlots(input.config.bufferMinutes);
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
    const day = dayBoundsForSlot(input.week.days, leg.side === 'out' ? leg.window.start : leg.window.end);

    let placement: { carId: string; healWindow: Window; healOriginId: string; healDestinationId: string } | null = null;
    for (const car of sharedCars) {
      if (!fits(car, nr.passengers) || !luggageFits(car, nr.luggage ? 1 : 0)) continue;
      const tl = timelines.get(car.id);
      if (!tl) continue;
      const probeId = `heal-probe:${nr.id}`;

      if (leg.side === 'out') {
        if (!tl.isFree(leg.window, leg.originId)) continue;
        const healWindow = { start: day.dayEndSlot - nr.travelSlots, end: day.dayEndSlot };
        if (leg.window.end + bufferSlots > healWindow.start) continue;
        tl.add({ rideId: probeId, window: leg.window, startLocationId: leg.originId, endLocationId: leg.destinationId, overnightAck: false });
        const healFree = tl.isFree(healWindow, leg.destinationId);
        tl.remove(probeId);
        if (!healFree) continue;
        placement = { carId: car.id, healWindow, healOriginId: leg.destinationId, healDestinationId: home };
      } else {
        const healWindow = { start: leg.window.start - bufferSlots - nr.travelSlots, end: leg.window.start - bufferSlots };
        if (healWindow.start < day.startSlot) continue;
        if (!tl.isFree(healWindow, home)) continue;
        tl.add({ rideId: probeId, window: healWindow, startLocationId: home, endLocationId: leg.originId, overnightAck: false });
        const legFree = tl.isFree(leg.window, leg.originId);
        tl.remove(probeId);
        if (!legFree) continue;
        placement = { carId: car.id, healWindow, healOriginId: home, healDestinationId: leg.originId };
      }
      break;
    }

    if (!placement) continue;

    const tl = timelines.get(placement.carId);
    if (!tl) continue;
    const car = carsById.get(placement.carId);
    const legRideId = `ride:${nr.id}`;
    const relocRideId = `reloc:${nr.id}`;

    if (leg.side === 'out') {
      tl.add({ rideId: legRideId, window: leg.window, startLocationId: leg.originId, endLocationId: leg.destinationId, overnightAck: false });
      tl.add({ rideId: relocRideId, window: placement.healWindow, startLocationId: placement.healOriginId, endLocationId: placement.healDestinationId, overnightAck: false });
    } else {
      tl.add({ rideId: relocRideId, window: placement.healWindow, startLocationId: placement.healOriginId, endLocationId: placement.healDestinationId, overnightAck: false });
      tl.add({ rideId: legRideId, window: leg.window, startLocationId: leg.originId, endLocationId: leg.destinationId, overnightAck: false });
    }

    const depSlot = leg.side === 'out' ? leg.window.start : placement.healWindow.start;
    const retSlot = leg.side === 'out' ? placement.healWindow.end : leg.window.end;
    const legText = reason('PLACED_RELAY_SOLO', {
      car: car?.name ?? placement.carId,
      member: nr.request.memberId,
      dest: nr.destinationId,
      dep: formatSlotTime(depSlot, day),
      ret: formatSlotTime(retSlot, day),
    });

    healed.push({
      rideId: legRideId,
      carId: placement.carId,
      window: leg.window,
      originId: leg.originId,
      destinationId: leg.destinationId,
      driverRequestId: nr.id,
      driverMemberId: nr.request.memberId,
      legs: [{ requestId: nr.id, leg: leg.side, carMode: 'relay', originId: leg.originId, destinationId: leg.destinationId, role: 'driver' }],
      servedRequestIds: [nr.id],
      passengers: nr.passengers,
      luggageCount: nr.luggage ? 1 : 0,
      shift: { departureMin: 0, returnMin: 0 },
      pairedRideId: relocRideId,
      source: 'solver',
      reasonCode: 'PLACED_RELAY_SOLO',
      reason: legText,
    });

    healed.push({
      rideId: relocRideId,
      carId: placement.carId,
      window: placement.healWindow,
      originId: placement.healOriginId,
      destinationId: placement.healDestinationId,
      driverRequestId: undefined,
      driverMemberId: undefined,
      legs: [],
      servedRequestIds: [],
      passengers: { adults: 0, childSeats: 0, boosters: 0 },
      luggageCount: 0,
      shift: { departureMin: 0, returnMin: 0 },
      pairedRideId: legRideId,
      source: 'solver',
      reasonCode: 'PLACED_NEEDS_DRIVER',
      reason: reason('PLACED_NEEDS_DRIVER', { car: car?.name ?? placement.carId }),
    });

    healedIds.add(nr.id);
  }

  return { healed, healedIds };
}
