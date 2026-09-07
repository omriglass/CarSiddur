// src/solver/live.ts
//
// Post-publish live-phase helpers (docs/SOLVER.md §5.2). Neither ever
// relocates or displaces an existing ride — they only add a ride into free
// time. matchFreedSlot may use the candidate's declared flexibility;
// tryAutoApprove only places a request at its exact requested time (no
// human in the loop).

import { carPreferenceRank } from './carPreference';
import { bestPlacementWithinFlex } from './flexibility';
import { scoreRequests } from './policy/engine';
import { reason } from './reasons';
import { fits, luggageFits, slack } from './seatFit';
import { byId, dayBoundsForSlot, formatSlotTime, normalize, withinRequestDay } from './slots';
import type { CarTimeline } from './timeline';
import type {
  Assignment,
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

/** One-way requests are never freed-slot candidates (REQUIREMENTS §13.64) — they need a partner, host or driver. */
export function matchFreedSlot(input: FreedSlotInput): FreedSlotCandidate[] {
  if (input.freedLocationId !== input.homeLocationId) return [];

  const pseudoInput: SolverInput = {
    week: input.week,
    homeLocationId: input.homeLocationId,
    cars: [input.car],
    requests: input.candidates,
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

export interface AutoApproveInput {
  request: Request;
  cars: Car[];
  timelines: Record<string, CarTimeline>;
  config: SolverConfig;
  stats: SolverStats;
  week: SolverInput['week'];
  homeLocationId: string;
}

/** Places a round-trip request only at its preferred time on a shared car free and at home; null otherwise. One-way requests always return null. */
export function tryAutoApprove(input: AutoApproveInput): Assignment | null {
  if (input.request.tripShape !== 'round_trip') return null;

  const pseudoInput: SolverInput = {
    week: input.week,
    homeLocationId: input.homeLocationId,
    cars: input.cars,
    requests: [input.request],
    fixedRides: [],
    destinations: {},
    policy: { id: '', version: 0, rules: [] },
    stats: input.stats,
    config: input.config,
  };
  const { normalized } = normalize(pseudoInput);
  const nr = normalized[0];
  if (!nr || !withinRequestDay(nr, nr.window)) return null;

  const sharedCars = input.cars.filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1));
  let best: { car: Car; slackVal: number; preference: number } | null = null;
  for (const car of sharedCars) {
    if (!fits(car, nr.passengers) || !luggageFits(car, nr.luggage ? 1 : 0)) continue;
    const tl = input.timelines[car.id];
    if (!tl) continue;
    if (!tl.isFree(nr.window, input.homeLocationId)) continue;
    const slackVal = slack(car, nr.passengers) ?? Number.POSITIVE_INFINITY;
    const preference = carPreferenceRank(car.id, [input.request.preferredCarId]);
    if (!best || preference < best.preference || (preference === best.preference && (slackVal < best.slackVal || (slackVal === best.slackVal && car.id < best.car.id)))) {
      best = { car, slackVal, preference };
    }
  }
  if (!best) return null;

  return {
    rideId: `ride:${nr.id}`,
    carId: best.car.id,
    window: nr.window,
    originId: input.homeLocationId,
    destinationId: input.homeLocationId,
    driverRequestId: nr.id,
    driverMemberId: input.request.memberId,
    legs: [
      {
        requestId: nr.id,
        leg: 'both',
        carMode: 'keep',
        originId: input.homeLocationId,
        destinationId: input.request.destinationId,
        role: 'driver',
      },
    ],
    servedRequestIds: [nr.id],
    passengers: nr.passengers,
    luggageCount: nr.luggage ? 1 : 0,
    shift: { departureMin: 0, returnMin: 0 },
    source: 'solver',
    reasonCode: 'PLACED_PREFERRED',
    reason: reason('PLACED_PREFERRED', { car: best.car.name }),
  };
}
