// src/solver/suggestions.ts
//
// Suggestion generation (docs/SOLVER.md §3.11, REQUIREMENTS §7.1 order):
// 1 shiftWithinFlex (only from the improvement pass's ejection candidates)
// 2 merge  3 shiftBeyondFlex  4 splitLegs  5 convertToRoundTrip/chauffeur
// (one-way legs only)  6 externalHint  7 deny (always last, always present).

import { bestPlacementWithinFlex } from './flexibility';
import type { HostRide } from './merge';
import { buildHostRides, findMergeHosts } from './merge';
import { reason } from './reasons';
import { carName as carNameOf, placeName, requestDestName, rideHostLabel } from './names';
import { chauffeurLoad, fits, luggageFits } from './seatFit';
import { dayBoundsForSlot, formatSlotTime, minutesToSlots, travelSlotsFor, type NormalizedRequest } from './slots';
import type { SplitLegsContext } from './splitLegs';
import { trySplitLegs } from './splitLegs';
import { CarTimeline } from './timeline';
import { chauffeurCandidates } from './travel';
import type { Assignment, Car, Destination, LegSide, SolverConfig, SolverInput, Suggestion, Window } from './types';

export interface SuggestionContext {
  input: SolverInput;
  assignments: Assignment[];
  timelines: Map<string, CarTimeline>;
  hostDriverRequests: Map<string, NormalizedRequest>;
  unpairedRelay: NormalizedRequest[];
  ejectionSuggestions: Map<string, Suggestion>;
}

function isRelay(nr: NormalizedRequest): boolean {
  return nr.legs[0]?.preferredMode === 'relay' && nr.legs[0].side !== 'both';
}

function volunteerCandidates(input: SolverInput, window: { start: number; end: number }): string[] {
  // Members already driving that day with no overlapping ride, sorted by id (informational).
  const driversToday = new Set<string>();
  for (const a of input.fixedRides) {
    const overlaps = a.window.start < window.end && window.start < a.window.end;
    if (!overlaps && a.driverMemberId) driversToday.add(a.driverMemberId);
  }
  return [...driversToday].sort();
}

/** Owner decision 2026-09-14: a `chauffeur` suggestion is offered only when it is
 *  actually possible — some shared car is free for the whole chauffeur window
 *  (REQUIREMENTS §13.93, owner follow-up 2026-10-04, ORIGINS_PLAN §3: tried at
 *  the leg's origin — drop-off — then its destination — pickup, e.g. "pick me
 *  up from Harish"; a `return` leg keeps the legacy single formula) and its
 *  seat configuration fits `chauffeurLoad(nr.passengers)` (the requester's
 *  load plus the volunteer). Returns the first qualifying car/candidate in the
 *  existing deterministic order, or null if none qualifies. */
function findChauffeurCar(
  nr: NormalizedRequest,
  side: 'out' | 'return',
  point: number,
  ctx: SuggestionContext,
): { carId: string; window: Window } | null {
  const dwellSlots = minutesToSlots(ctx.input.config.chauffeurDwellMinutes);
  // Multi-stop rides (REQUIREMENTS §13.93 "Multi-stop rides"): nr.travelSlots
  // is already the leg's own route duration; the chauffeur's empty
  // repositioning drive never revisits the stops (directSlots).
  const directSlots = travelSlotsFor(ctx.input, nr.originId, nr.destinationId);
  const candidates = chauffeurCandidates(side, point, nr.travelSlots, directSlots, dwellSlots, nr.originId, nr.destinationId);
  const day = dayBoundsForSlot(ctx.input.week.days, point);
  const load = chauffeurLoad(nr.passengers);
  const sharedCars = ctx.input.cars.filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const candidate of candidates) {
    if (candidate.window.start < day.startSlot || candidate.window.end > day.endSlot) continue;
    for (const car of sharedCars) {
      if (!fits(car, load) || !luggageFits(car, nr.luggage ? 1 : 0)) continue;
      const tl = ctx.timelines.get(car.id);
      if (!tl || !tl.isFree(candidate.window, candidate.carOriginId)) continue;
      return { carId: car.id, window: candidate.window };
    }
  }
  return null;
}

function externalHints(nr: NormalizedRequest, destination: Destination | undefined, config: SolverConfig, input: SolverInput): Suggestion[] {
  const out: Suggestion[] = [];
  const occupancyMinutes = nr.travelSlots * 15 + (nr.request.tripShape === 'round_trip' ? (nr.window.end - nr.window.start) * 15 - nr.travelSlots * 15 * 2 : 0);
  const singleLeg = nr.request.tripShape !== 'round_trip';
  const distanceKm = destination?.distanceKm;

  if ((singleLeg || occupancyMinutes <= config.externalHints.cabMaxMinutes) && (distanceKm ?? 0) <= 30) {
    out.push({
      kind: 'externalHint',
      requestId: nr.id,
      hint: 'cab',
      reasonCode: 'SUGGEST_EXTERNAL_CAB',
      reason: reason('SUGGEST_EXTERNAL_CAB'),
      cost: 0,
      confidence: 0.3,
    });
  }
  if (occupancyMinutes >= config.externalHints.rentalMinHours * 60) {
    out.push({
      kind: 'externalHint',
      requestId: nr.id,
      hint: 'rental',
      reasonCode: 'SUGGEST_EXTERNAL_RENTAL',
      reason: reason('SUGGEST_EXTERNAL_RENTAL'),
      cost: 0,
      confidence: 0.3,
    });
  }
  if ((destination?.publicTransportScore ?? 0) >= config.externalHints.ptMinScore) {
    out.push({
      kind: 'externalHint',
      requestId: nr.id,
      hint: 'publicTransport',
      reasonCode: 'SUGGEST_EXTERNAL_PT',
      reason: reason('SUGGEST_EXTERNAL_PT', { dest: requestDestName(input, nr.request) }),
      cost: 0,
      confidence: 0.3,
    });
  }
  return out;
}

function denySuggestion(nr: NormalizedRequest, blockers: string[], input: SolverInput): Suggestion {
  return {
    kind: 'deny',
    requestId: nr.id,
    reasonCode: 'SUGGEST_DENY',
    reason: reason('SUGGEST_DENY', { blockers: blockers.map((id) => carNameOf(input.cars, id)).filter(Boolean).join(', ') }),
    cost: 0,
    confidence: 1,
  };
}

function mergeSuggestions(nr: NormalizedRequest, leg: LegSide, ctx: SuggestionContext, hosts: HostRide[]): Suggestion[] {
  const candidates = findMergeHosts({
    guest: nr,
    leg,
    hosts,
    destinations: ctx.input.destinations,
    config: ctx.input.config,
    cars: new Map(ctx.input.cars.map((c) => [c.id, c])),
    hostDriverRequests: ctx.hostDriverRequests,
    hostTimelines: ctx.timelines,
    homeLocationId: ctx.input.homeLocationId,
    travel: ctx.input.travel,
  }).slice(0, 3);

  return candidates.map((c) => {
    const day = dayBoundsForSlot(ctx.input.week.days, c.window.start);
    const carName = carNameOf(ctx.input.cars, c.carId);
    const code = c.detourMinutes === 0 ? 'SUGGEST_MERGE' : 'SUGGEST_MERGE_DETOUR';
    return {
      kind: 'merge' as const,
      requestId: nr.id,
      hostRideId: c.hostRideId,
      guestRequestIds: [nr.id],
      leg,
      proposedDriverRequestId: c.proposedDriverRequestId,
      window: c.window,
      hostShift: c.hostShift,
      detourMinutes: c.detourMinutes,
      detourKm: c.detourKm,
      reasonCode: code,
      reason: reason(code, {
        host: rideHostLabel(ctx.input, ctx.assignments, c.hostRideId) || carName,
        dest: requestDestName(ctx.input, nr.request),
        dep: formatSlotTime(c.window.start, day),
        ret: formatSlotTime(c.window.end, day),
        minutes: c.detourMinutes,
      }),
      cost: c.cost,
      confidence: c.confidence,
      boardAtLocationId: c.boardAtLocationId,
      hostWindowBefore: c.hostWindowBefore,
      addedOutMinutes: c.addedOutMinutes,
      addedReturnMinutes: c.addedReturnMinutes,
    };
  });
}

function shiftBeyondFlexSuggestion(nr: NormalizedRequest, ctx: SuggestionContext): Suggestion | null {
  const sharedCars = ctx.input.cars.filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1));
  let best: { car: Car; placement: NonNullable<ReturnType<typeof bestPlacementWithinFlex>> } | null = null;
  for (const car of sharedCars) {
    if (!fits(car, nr.passengers) || !luggageFits(car, nr.luggage ? 1 : 0)) continue;
    const tl = ctx.timelines.get(car.id);
    if (!tl) continue;
    const placement = bestPlacementWithinFlex(tl, nr, { widenMinutes: ctx.input.config.beyondFlexMaxMinutes });
    if (!placement) continue;
    if (!best || placement.cost < best.placement.cost) best = { car, placement };
  }
  if (!best) return null;
  // A 0-minute shift is not a suggestion: the greedy retry passes would already have placed it.
  if (best.placement.shift.departureMin === 0 && best.placement.shift.returnMin === 0) return null;
  return {
    kind: 'shiftBeyondFlex',
    requestId: nr.id,
    carId: best.car.id,
    window: best.placement.window,
    shift: best.placement.shift,
    reasonCode: 'SUGGEST_BEYOND_FLEX',
    reason: reason('SUGGEST_BEYOND_FLEX', {
      dep: String(Math.abs(best.placement.shift.departureMin)),
    }),
    cost: best.placement.cost,
    confidence: Math.max(0, 0.5 - best.placement.cost / 480),
  };
}

export function buildSuggestions(nr: NormalizedRequest, ctx: SuggestionContext, blockerCarIds: string[]): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const hosts = buildHostRides(ctx.assignments, new Map(ctx.input.cars.map((c) => [c.id, c])));
  const leg = nr.legs[0];

  const ejection = ctx.ejectionSuggestions.get(nr.id);
  if (ejection) suggestions.push(ejection);

  if (leg?.side === 'both') {
    suggestions.push(...mergeSuggestions(nr, 'both', ctx, hosts));
    const beyond = shiftBeyondFlexSuggestion(nr, ctx);
    if (beyond) suggestions.push(beyond);
    if (!nr.request.needsCarAtDestination) {
      const splitCtx: SplitLegsContext = {
        destinations: ctx.input.destinations,
        config: ctx.input.config,
        cars: new Map(ctx.input.cars.map((c) => [c.id, c])),
        assignments: ctx.assignments,
        hostDriverRequests: ctx.hostDriverRequests,
        timelines: ctx.timelines,
        unpairedRelay: ctx.unpairedRelay,
        home: ctx.input.homeLocationId,
        travel: ctx.input.travel,
      };
      const split = trySplitLegs(nr, splitCtx);
      if (split) {
        suggestions.push({
          kind: 'splitLegs',
          requestId: nr.id,
          outbound: {
            hostRideId: split.outbound.hostRideId,
            carMode: split.outbound.carMode,
            departSlot: split.outbound.slot,
            carId: split.outbound.carId,
          },
          return: {
            hostRideId: split.return.hostRideId,
            carMode: split.return.carMode,
            arriveSlot: split.return.slot,
            carId: split.return.carId,
          },
          reasonCode: 'SUGGEST_SPLIT_LEGS',
          reason: reason('SUGGEST_SPLIT_LEGS', {
            outbound: split.outbound.carMode,
            return: split.return.carMode,
          }),
          cost: split.cost,
          confidence: split.confidence,
        });
      }
    }
  } else if (nr.isPassengerOnly) {
    const side: LegSide = leg?.side === 'return' ? 'return' : 'out';
    const merges = mergeSuggestions(nr, side, ctx, hosts);
    suggestions.push(...merges);
    if (merges.length === 0) {
      const point = side === 'out' ? nr.window.start : nr.window.end;
      const candidate = findChauffeurCar(nr, side, point, ctx);
      if (candidate) {
        const day = dayBoundsForSlot(ctx.input.week.days, nr.window.start || nr.window.end);
        suggestions.push({
          kind: 'chauffeur',
          requestId: nr.id,
          leg: side,
          carId: candidate.carId,
          window: candidate.window,
          volunteerCandidateMemberIds: volunteerCandidates(ctx.input, candidate.window),
          reasonCode: 'SUGGEST_CHAUFFEUR',
          reason: reason('SUGGEST_CHAUFFEUR', {
            dest: requestDestName(ctx.input, nr.request),
            dep: formatSlotTime(nr.window.start, day),
            minutes: nr.travelSlots * 15 * 2 + ctx.input.config.chauffeurDwellMinutes,
          }),
          cost: 0,
          confidence: 0.5,
        });
      }
    }
  } else if (isRelay(nr)) {
    // Unpaired relay leg (§3.11 item 5): no shift/merge is meaningful (the car
    // would end the day away regardless), go straight to convertToRoundTrip / chauffeur.
    if (leg?.side === 'out') {
      const day = dayBoundsForSlot(ctx.input.week.days, leg.window.start);
      const sharedCars = ctx.input.cars.filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const car of sharedCars) {
        if (!fits(car, nr.passengers) || !luggageFits(car, nr.luggage ? 1 : 0)) continue;
        const tl = ctx.timelines.get(car.id);
        if (!tl) continue;
        // Latest feasible return that day: search gaps at destination for the latest end <= dayEndSlot.
        const dayBounds = dayBoundsForSlot(ctx.input.week.days, leg.window.start);
        let latestReturn: number | null = null;
        for (const gap of tl.gaps()) {
          if (gap.locationId !== nr.destinationId) continue;
          if (gap.window.start > leg.window.end) continue;
          const candidateEnd = Math.min(gap.window.end, dayBounds.dayEndSlot);
          if (candidateEnd - leg.window.end >= nr.travelSlots) {
            latestReturn = candidateEnd;
          }
        }
        if (latestReturn !== null) {
          suggestions.push({
            kind: 'convertToRoundTrip',
            requestId: nr.id,
            carId: car.id,
            window: { start: leg.window.start, end: latestReturn },
            returnSlot: latestReturn,
            reasonCode: 'SUGGEST_ROUND_TRIP',
            reason: reason('SUGGEST_ROUND_TRIP', { dest: requestDestName(ctx.input, nr.request), ret: formatSlotTime(latestReturn, day) }),
            cost: 0,
            confidence: 0.4,
          });
          break;
        }
      }
    }
    {
      const side: 'out' | 'return' = leg?.side === 'return' ? 'return' : 'out';
      const point = side === 'out' ? (leg?.window.start ?? 0) : (leg?.window.end ?? 0);
      const candidate = findChauffeurCar(nr, side, point, ctx);
      if (candidate) {
        const day = dayBoundsForSlot(ctx.input.week.days, leg?.window.start ?? 0);
        suggestions.push({
          kind: 'chauffeur',
          requestId: nr.id,
          leg: side,
          carId: candidate.carId,
          window: candidate.window,
          volunteerCandidateMemberIds: volunteerCandidates(ctx.input, candidate.window),
          reasonCode: 'SUGGEST_CHAUFFEUR',
          reason: reason('SUGGEST_CHAUFFEUR', {
            dest: requestDestName(ctx.input, nr.request),
            dep: formatSlotTime(nr.window.start, day),
            minutes: nr.travelSlots * 15 * 2 + ctx.input.config.chauffeurDwellMinutes,
          }),
          cost: 0,
          confidence: 0.5,
        });
      }
    }
  }

  const changeOrigin = changeOriginSuggestion(nr, ctx);
  if (changeOrigin) suggestions.push(changeOrigin);

  const destination = ctx.input.destinations[nr.destinationId];
  suggestions.push(...externalHints(nr, destination, ctx.input.config, ctx.input));
  suggestions.push(denySuggestion(nr, blockerCarIds, ctx.input));

  return suggestions;
}

/**
 * REQUIREMENTS §13.93, ORIGINS_PLAN §4 item 6: for an unmet request, a car
 * that is free for the request's *whole preferred window* at another place Y
 * (somewhere that car already is, so placing the request's origin there
 * breaks nothing) — mapped to proposal type `origin` (SOLVER §3.15), shown to
 * the Sadran only, never auto-applied. Simplification (documented, in the
 * style of SOLVER §9): only the preferred window is tried (no flex search),
 * on the first car/location pair found in deterministic order; a
 * zero-duration window (a passenger-only leg's single point in time) never
 * qualifies — there is no "whole window" to be free for.
 */
function changeOriginSuggestion(nr: NormalizedRequest, ctx: SuggestionContext): Suggestion | null {
  if (nr.window.end <= nr.window.start) return null;
  // Only trip types the SQL `origin` proposal can place through `try_auto_approve`
  // (round_trip, one_way, drop_off with a pickup); a one-leg drop_off is served by
  // pairing/chauffeur rides, never by "take the car from Y" (DATA_MODEL O3).
  const placeable = nr.tripType === 'round_trip' || nr.tripType === 'one_way'
    || (nr.tripType === 'drop_off' && nr.request.tripShape === 'round_trip');
  if (!placeable) return null;
  const sharedCars = ctx.input.cars.filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const car of sharedCars) {
    if (!fits(car, nr.passengers) || !luggageFits(car, nr.luggage ? 1 : 0)) continue;
    const tl = ctx.timelines.get(car.id);
    if (!tl) continue;
    const seen = new Set<string>([nr.originId]);
    for (const gap of tl.gaps()) {
      if (seen.has(gap.locationId)) continue;
      seen.add(gap.locationId);
      // A one_way trip leaves the car at the destination: the same end check as
      // placement (the car's next ride must start there, or there is none).
      const endLocationId = nr.tripType === 'one_way' ? nr.destinationId : gap.locationId;
      if (gap.window.start <= nr.window.start && nr.window.end <= gap.window.end
        && tl.isFree(nr.window, gap.locationId, undefined, endLocationId)) {
        return {
          kind: 'changeOrigin',
          requestId: nr.id,
          carId: car.id,
          originId: gap.locationId,
          window: nr.window,
          reasonCode: 'SUGGEST_CHANGE_ORIGIN',
          reason: reason('SUGGEST_CHANGE_ORIGIN', { origin: placeName(ctx.input, gap.locationId), car: car.name }),
          cost: 0,
          confidence: 0.4,
        };
      }
    }
  }
  return null;
}
