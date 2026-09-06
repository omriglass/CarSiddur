// src/solver/flexibility.ts
//
// bestPlacementWithinFlex (docs/SOLVER.md §3.7): for each free gap of the car
// whose location equals the leg's origin, the feasible region is computed
// and clamped to the closest point to the preferred time — O(1) per gap, no
// enumeration of shift pairs. The same function, with the flex intervals
// widened by `beyondFlexMaxMinutes`, powers the shiftBeyondFlex suggestion.

import type { NormalizedRequest, NormalizedLeg } from './slots';
import { minutesToSlots, slotsToMinutes } from './slots';
import type { CarTimeline, Gap } from './timeline';
import type { Window } from './types';

export interface Placement {
  window: Window;
  shift: { departureMin: number; returnMin: number };
  /** total |shift| in minutes; part 1 of the car choice key (SOLVER §3.6) */
  cost: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function placeInGap(nr: NormalizedRequest, leg: NormalizedLeg, gap: Gap, widenSlots: number): Placement | null {
  const g1 = gap.window.start;
  const g2 = gap.window.end;

  if (leg.side === 'both') {
    const D = nr.window.start;
    const R = nr.window.end;
    const depLo = nr.flexDep[0] - widenSlots;
    const depHi = nr.flexDep[1] + widenSlots;
    const retLo = nr.flexRet[0] - widenSlots;
    const retHi = nr.flexRet[1] + widenSlots;
    const depRange: [number, number] = [Math.max(depLo, g1), depHi];
    const retRange: [number, number] = [retLo, Math.min(retHi, g2)];
    if (depRange[0] > depRange[1] || retRange[0] > retRange[1]) return null;
    const dep = clamp(D, depRange[0], depRange[1]);
    const ret = clamp(R, retRange[0], retRange[1]);
    if (ret - dep < nr.minDurationSlots || dep < g1 || ret > g2 || dep > ret) return null;
    return {
      window: { start: dep, end: ret },
      shift: { departureMin: slotsToMinutes(dep - D), returnMin: slotsToMinutes(ret - R) },
      cost: slotsToMinutes(Math.abs(dep - D)) + slotsToMinutes(Math.abs(ret - R)),
    };
  }

  if (leg.side === 'out') {
    const D = nr.window.start;
    const depLo = nr.flexDep[0] - widenSlots;
    const depHi = nr.flexDep[1] + widenSlots;
    const depRange: [number, number] = [Math.max(depLo, g1), Math.min(depHi, g2 - nr.minDurationSlots)];
    if (depRange[0] > depRange[1]) return null;
    const dep = clamp(D, depRange[0], depRange[1]);
    const end = dep + nr.minDurationSlots;
    if (end > g2) return null;
    return {
      window: { start: dep, end },
      shift: { departureMin: slotsToMinutes(dep - D), returnMin: 0 },
      cost: slotsToMinutes(Math.abs(dep - D)),
    };
  }

  // 'return'
  const R = nr.window.end;
  const retLo = nr.flexRet[0] - widenSlots;
  const retHi = nr.flexRet[1] + widenSlots;
  const retRange: [number, number] = [Math.max(retLo, g1 + nr.minDurationSlots), Math.min(retHi, g2)];
  if (retRange[0] > retRange[1]) return null;
  const ret = clamp(R, retRange[0], retRange[1]);
  const start = ret - nr.minDurationSlots;
  if (start < g1) return null;
  return {
    window: { start, end: ret },
    shift: { departureMin: 0, returnMin: slotsToMinutes(ret - R) },
    cost: slotsToMinutes(Math.abs(ret - R)),
  };
}

/**
 * Best (minimal-shift) placement of `nr`'s single leg on `tl`, searching every
 * free gap whose location matches the leg's origin. `widenMinutes` extends
 * both flex bounds symmetrically (used for the beyondFlex search, SOLVER §3.11).
 */
export function bestPlacementWithinFlex(
  tl: CarTimeline,
  nr: NormalizedRequest,
  opts: { widenMinutes?: number } = {},
): Placement | null {
  const leg = nr.legs[0];
  if (!leg) return null;
  const widenSlots = minutesToSlots(opts.widenMinutes ?? 0);
  let best: Placement | null = null;
  for (const gap of tl.gaps()) {
    if (gap.locationId !== leg.originId) continue;
    const candidate = placeInGap(nr, leg, gap, widenSlots);
    if (!candidate) continue;
    if (
      !best ||
      candidate.cost < best.cost ||
      (candidate.cost === best.cost && candidate.window.start < best.window.start)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** Lower-level placement of an arbitrary leg (used by relay pairing / split legs to place one leg at a time). */
export function bestPlacementForLeg(
  tl: CarTimeline,
  nr: NormalizedRequest,
  leg: NormalizedLeg,
  widenMinutes = 0,
): Placement | null {
  const widenSlots = minutesToSlots(widenMinutes);
  let best: Placement | null = null;
  for (const gap of tl.gaps()) {
    if (gap.locationId !== leg.originId) continue;
    const candidate = placeInGap(nr, leg, gap, widenSlots);
    if (!candidate) continue;
    if (!best || candidate.cost < best.cost) best = candidate;
  }
  return best;
}
