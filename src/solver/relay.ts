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

import type { NormalizedRequest } from './slots';
import { byId, withinRequestDay } from './slots';
import type { Car, Window } from './types';
import { fits } from './seatFit';

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
