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
import { chauffeurLoad, fits, needsFit } from './seatFit';
import { byId, dayBoundsForSlot, formatSlotTime, minutesToSlots, normalize, travelSlotsFor } from './slots';
import type { NormalizedRequest } from './slots';
import { chauffeurCandidates, chauffeurTotalSlots, originIdOf, resolveStopMinutes } from './travel';
import type { CarTimeline } from './timeline';
import type {
  Car,
  Destination,
  Policy,
  Request,
  SolverConfig,
  SolverInput,
  SolverStats,
  TravelEdge,
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
  /** REQUIREMENTS §13.93 (ORIGINS_PLAN §4): read only via `travelBetween()`, same as `SolverInput.travel`. */
  travel?: TravelEdge[];
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
 * a one-leg drop_off is (REQ §13.193: a chauffeur ride at its own time, no shift);
 * they need a partner, host or driver. Multi-day series legs are excluded
 * too (SOLVER §3.x): they are immovable and placed all-or-nothing across
 * every leg's own day, never into a single freed slot.
 */
export function matchFreedSlot(
  input: FreedSlotInput,
  opts?: { priorityRequestIds?: readonly string[] },
): FreedSlotCandidate[] {
  const priority = new Set(opts?.priorityRequestIds ?? []);
  // REQUIREMENTS §13.93: a candidate only matters if its own declared origin
  // is where the car was actually freed — generalizes the old strict
  // "freedLocationId === home" check (every legacy request's origin is home).
  const candidates = input.candidates.filter(
    (r) => originIdOf(r, input.homeLocationId) === input.freedLocationId,
  );
  if (candidates.length === 0) return [];

  const pseudoInput: SolverInput = {
    week: input.week,
    homeLocationId: input.homeLocationId,
    cars: [input.car],
    requests: candidates.filter((r) => r.seriesId === undefined),
    fixedRides: [],
    destinations: input.destinations,
    policy: input.policy,
    stats: input.stats,
    config: input.config,
    travel: input.travel,
  };
  const { normalized } = normalize(pseudoInput);
  const roundTrips = normalized.filter((nr) => nr.legs[0]?.side === 'both');
  // REQ §13.193: a drop_off ("hakpatza") with one leg (drop-off only or pickup only) takes the freed car as a chauffeur ride at its own time.
  const singleDropOffs = normalized.filter((nr) => nr.tripType === 'drop_off' && nr.legs.length === 1 && nr.legs[0]?.side !== 'both');
  const { scores } = scoreRequests(pseudoInput, [...roundTrips, ...singleDropOffs]);

  const results: FreedSlotCandidate[] = [];
  for (const nr of roundTrips) {
    const envelopeStart = nr.flexDep[0];
    const envelopeEnd = nr.flexRet[1];
    if (envelopeEnd <= input.freedWindow.start || input.freedWindow.end <= envelopeStart) continue;
    if (!fits(input.car, nr.passengers) || !needsFit(input.car, nr.luggage ? 1 : 0, nr.tow ? 1 : 0)) continue;
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
  for (const nr of singleDropOffs) {
    const window = singleDropOffWindow(pseudoInput, input.timeline, input.car, nr);
    if (!window) continue;
    const day = dayBoundsForSlot(input.week.days, window.start);
    results.push({
      requestId: nr.id,
      window,
      shift: { departureMin: 0, returnMin: 0 },
      score: scores.get(nr.id)?.total ?? 0,
      reason: reason('PLACED_PREFERRED', {
        car: input.car.name,
        dep: formatSlotTime(window.start, day),
        ret: formatSlotTime(window.end, day),
      }),
    });
  }

  results.sort((a, b) => {
    const pa = priority.has(a.requestId) ? 0 : 1;
    const pb = priority.has(b.requestId) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.score !== b.score) return b.score - a.score;
    const shiftA = Math.abs(a.shift.departureMin) + Math.abs(a.shift.returnMin);
    const shiftB = Math.abs(b.shift.departureMin) + Math.abs(b.shift.returnMin);
    if (shiftA !== shiftB) return shiftA - shiftB;
    return byId({ id: a.requestId }, { id: b.requestId });
  });
  return results;
}

/** The chauffeur ride of a one-leg drop_off on the freed car at the leg's own time (the same candidates as placement,
 *  `relay.ts`), or null when the car cannot take it there and then. */
function singleDropOffWindow(input: SolverInput, timeline: CarTimeline, car: Car, nr: NormalizedRequest): Window | null {
  const leg = nr.legs[0];
  if (!leg || leg.side === 'both') return null;
  if (!fits(car, chauffeurLoad(nr.passengers)) || !needsFit(car, nr.luggage ? 1 : 0, nr.tow ? 1 : 0)) return null;
  const side: 'out' | 'return' = leg.side === 'out' ? 'out' : 'return';
  const point = side === 'out' ? leg.window.start : leg.window.end;
  const day = dayBoundsForSlot(input.week.days, point);
  const totalSlots = chauffeurTotalSlots(input, nr.request, side, nr.originId, nr.destinationId, resolveStopMinutes(input.config), input.config.chauffeurDwellMinutes);
  const candidates = chauffeurCandidates(side, point, nr.travelSlots, travelSlotsFor(input, nr.originId, nr.destinationId),
    minutesToSlots(input.config.chauffeurDwellMinutes), nr.originId, nr.destinationId, totalSlots);
  for (const candidate of candidates) {
    if (candidate.window.start < day.startSlot || candidate.window.end > day.endSlot) continue;
    if (timeline.isFree(candidate.window, candidate.carOriginId)) return candidate.window;
  }
  return null;
}

/** One candidate for `freedSlotOptions`: its own requested window (slots) and policy score. */
export interface FreedSlotOptionItem {
  requestId: string;
  window: Window;
  score: number;
  /** Served by its plan B today (REQ §13.168): taking the car means leaving the plan B. */
  planB: boolean;
}

/** REQ §13.168: one way to use a freed car — one request, or several one after another. */
export interface FreedSlotOption {
  requestIds: string[];
  /** Sum of the requests' policy scores — what auto-solving by the policy would maximise. */
  score: number;
  /** Free slots of the gap this option leaves unused. */
  unusedSlots: number;
  /** How many of its requests leave a plan B. */
  planB: number;
  /** The top-ranked option (exactly one per non-empty list). */
  recommended: boolean;
}

/** Enumeration stops after this many options (a long gap with many short requests grows combinatorially). */
export const FREED_OPTIONS_ENUMERATION_CAP = 500;

/**
 * REQ §13.168: every way the freed gap can be used — each candidate alone, and every chain of candidates
 * that fit inside the gap one after another with the turnaround (`bufferSlots`) between them (no size
 * limit, owner 2026-10-31). Ranked: higher total policy score, then less unused time, then fewer people
 * leaving a plan B, then the request ids (deterministic). The first option is the recommendation.
 */
export function freedSlotOptions(items: readonly FreedSlotOptionItem[], freedWindow: Window, bufferSlots: number): FreedSlotOption[] {
  const inside = items
    .filter((it) => it.window.start >= freedWindow.start && it.window.end <= freedWindow.end && it.window.end > it.window.start)
    .sort((a, b) => a.window.start - b.window.start || a.window.end - b.window.end || byId({ id: a.requestId }, { id: b.requestId }));
  const gap = freedWindow.end - freedWindow.start;
  const found: Omit<FreedSlotOption, 'recommended'>[] = [];
  const chain: FreedSlotOptionItem[] = [];
  const walk = (from: number) => {
    for (let i = from; i < inside.length && found.length < FREED_OPTIONS_ENUMERATION_CAP; i++) {
      const next = inside[i];
      if (!next) continue;
      const last = chain[chain.length - 1];
      if (last && next.window.start < last.window.end + bufferSlots) continue;
      chain.push(next);
      const used = chain.reduce((sum, it) => sum + (it.window.end - it.window.start), 0);
      found.push({
        requestIds: chain.map((it) => it.requestId),
        score: chain.reduce((sum, it) => sum + it.score, 0),
        unusedSlots: Math.max(0, gap - used),
        planB: chain.filter((it) => it.planB).length,
      });
      walk(i + 1);
      chain.pop();
    }
  };
  walk(0);
  found.sort((a, b) =>
    b.score - a.score
    || a.unusedSlots - b.unusedSlots
    || a.planB - b.planB
    || a.requestIds.length - b.requestIds.length
    || (a.requestIds.join(',') < b.requestIds.join(',') ? -1 : a.requestIds.join(',') > b.requestIds.join(',') ? 1 : 0));
  return found.map((option, index) => ({ ...option, recommended: index === 0 }));
}
