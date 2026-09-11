// src/solver/live.ts
//
// Post-publish live-phase helper (docs/SOLVER.md §5.2): matchFreedSlot never
// relocates or displaces an existing ride — it only adds a ride into free
// time, and may use the candidate's declared flexibility. Auto-approve of
// newly submitted requests is a SQL-only concern (`try_auto_approve`,
// `supabase/migrations/20260907091500_rpc.sql` and later redefinitions);
// there is no TypeScript reference implementation.

import { bestPlacementWithinFlex } from './flexibility';
import { scoreRequests } from './policy/engine';
import { reason } from './reasons';
import { fits, luggageFits } from './seatFit';
import { byId, dayBoundsForSlot, formatSlotTime, normalize } from './slots';
import type { CarTimeline } from './timeline';
import type {
  Car,
  Destination,
  Policy,
  Request,
  SolverConfig,
  SolverInput,
  SolverStats,
  Window,
} from './types';

export interface FreedSlotInput {
  car: Car;
  timeline: CarTimeline;
  freedWindow: Window;
  freedLocationId: string;
  candidates: Request[];
  destinations: Record<string, Destination>;
  policy: Policy;
  stats: SolverStats;
  config: SolverConfig;
  week: SolverInput['week'];
  homeLocationId: string;
}

export interface FreedSlotCandidate {
  requestId: string;
  window: Window;
  shift: { departureMin: number; returnMin: number };
  score: number;
  reason: string;
}

/**
 * One-way requests are never freed-slot candidates (REQUIREMENTS §13.64) —
 * they need a partner, host or driver. Multi-day series legs are excluded
 * too (SOLVER §3.x): they are immovable and placed all-or-nothing across
 * every leg's own day, never into a single freed slot.
 */
export function matchFreedSlot(input: FreedSlotInput): FreedSlotCandidate[] {
  if (input.freedLocationId !== input.homeLocationId) return [];

  const pseudoInput: SolverInput = {
    week: input.week,
    homeLocationId: input.homeLocationId,
    cars: [input.car],
    requests: input.candidates.filter((r) => r.seriesId === undefined),
    fixedRides: [],
    destinations: input.destinations,
    policy: input.policy,
    stats: input.stats,
    config: input.config,
  };
  const { normalized } = normalize(pseudoInput);
  const roundTrips = normalized.filter((nr) => nr.legs[0]?.side === 'both');
  const { scores } = scoreRequests(pseudoInput, roundTrips);

  const results: FreedSlotCandidate[] = [];
  for (const nr of roundTrips) {
    const envelopeStart = nr.flexDep[0];
    const envelopeEnd = nr.flexRet[1];
    if (envelopeEnd <= input.freedWindow.start || input.freedWindow.end <= envelopeStart) continue;
    if (!fits(input.car, nr.passengers) || !luggageFits(input.car, nr.luggage ? 1 : 0)) continue;
    const placement = bestPlacementWithinFlex(input.timeline, nr);
    if (!placement) continue;
    const day = dayBoundsForSlot(input.week.days, placement.window.start);
    const code = placement.shift.departureMin === 0 && placement.shift.returnMin === 0 ? 'PLACED_PREFERRED' : 'PLACED_SHIFTED';
    results.push({
      requestId: nr.id,
      window: placement.window,
      shift: placement.shift,
      score: scores.get(nr.id)?.total ?? 0,
      reason: reason(code, {
        car: input.car.name,
        dep: formatSlotTime(placement.window.start, day),
        ret: formatSlotTime(placement.window.end, day),
      }),
    });
  }

  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const shiftA = Math.abs(a.shift.departureMin) + Math.abs(a.shift.returnMin);
    const shiftB = Math.abs(b.shift.departureMin) + Math.abs(b.shift.returnMin);
    if (shiftA !== shiftB) return shiftA - shiftB;
    return byId({ id: a.requestId }, { id: b.requestId });
  });
  return results;
}
