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
import { fits, luggageFits } from './seatFit';
import { dayBoundsForSlot, formatSlotTime, type NormalizedRequest } from './slots';
import type { SplitLegsContext } from './splitLegs';
import { trySplitLegs } from './splitLegs';
import { CarTimeline } from './timeline';
import type { Assignment, Car, Destination, LegSide, SolverConfig, SolverInput, Suggestion } from './types';

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
    if (!overlaps) driversToday.add(a.driverMemberId);
  }
  return [...driversToday].sort();
}

function externalHints(nr: NormalizedRequest, destination: Destination | undefined, config: SolverConfig): Suggestion[] {
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
      reason: reason('SUGGEST_EXTERNAL_PT', { dest: destination?.id ?? nr.destinationId }),
      cost: 0,
      confidence: 0.3,
    });
  }
  return out;
}

function denySuggestion(nr: NormalizedRequest, blockers: string[]): Suggestion {
  return {
    kind: 'deny',
    requestId: nr.id,
    reasonCode: 'SUGGEST_DENY',
    reason: reason('SUGGEST_DENY', { blockers: blockers.join(', ') }),
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
  }).slice(0, 3);

  return candidates.map((c) => {
    const day = dayBoundsForSlot(ctx.input.week.days, c.window.start);
    const hostRide = ctx.assignments.find((a) => a.rideId === c.hostRideId);
    const carName = ctx.input.cars.find((car) => car.id === c.carId)?.name ?? c.carId;
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
        host: hostRide?.driverMemberId ?? carName,
        dest: nr.destinationId,
        dep: formatSlotTime(c.window.start, day),
        ret: formatSlotTime(c.window.end, day),
        minutes: c.detourMinutes,
      }),
      cost: c.cost,
      confidence: c.confidence,
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
  return {
    kind: 'shiftBeyondFlex',
    requestId: nr.id,
    carId: best.car.id,
    window: best.placement.window,
    shift: best.placement.shift,
    reasonCode: 'SUGGEST_BEYOND_FLEX',
    reason: reason('SUGGEST_BEYOND_FLEX', {
      dep: `${Math.abs(best.placement.shift.departureMin)} דק'`,
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
      const day = dayBoundsForSlot(ctx.input.week.days, nr.window.start || nr.window.end);
      suggestions.push({
        kind: 'chauffeur',
        requestId: nr.id,
        leg: side,
        carId: '',
        window: nr.window,
        volunteerCandidateMemberIds: volunteerCandidates(ctx.input, nr.window),
        reasonCode: 'SUGGEST_CHAUFFEUR',
        reason: reason('SUGGEST_CHAUFFEUR', {
          dest: nr.destinationId,
          dep: formatSlotTime(nr.window.start, day),
          minutes: nr.travelSlots * 15 * 2 + ctx.input.config.chauffeurDwellMinutes,
        }),
        cost: 0,
        confidence: 0.5,
      });
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
            reason: reason('SUGGEST_ROUND_TRIP', { dest: nr.destinationId, ret: formatSlotTime(latestReturn, day) }),
            cost: 0,
            confidence: 0.4,
          });
          break;
        }
      }
    }
    const day = dayBoundsForSlot(ctx.input.week.days, leg?.window.start ?? 0);
    suggestions.push({
      kind: 'chauffeur',
      requestId: nr.id,
      leg: leg?.side === 'return' ? 'return' : 'out',
      carId: '',
      window: nr.window,
      volunteerCandidateMemberIds: volunteerCandidates(ctx.input, nr.window),
      reasonCode: 'SUGGEST_CHAUFFEUR',
      reason: reason('SUGGEST_CHAUFFEUR', {
        dest: nr.destinationId,
        dep: formatSlotTime(nr.window.start, day),
        minutes: nr.travelSlots * 15 * 2 + ctx.input.config.chauffeurDwellMinutes,
      }),
      cost: 0,
      confidence: 0.5,
    });
  }

  const destination = ctx.input.destinations[nr.destinationId];
  suggestions.push(...externalHints(nr, destination, ctx.input.config));
  suggestions.push(denySuggestion(nr, blockerCarIds));

  return suggestions;
}
