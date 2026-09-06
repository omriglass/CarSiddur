// src/solver/splitLegs.ts
//
// Split legs (docs/SOLVER.md §3.9): for an unmet round trip with
// needsCarAtDestination = false, each leg is resolved independently to
// passenger or relay. Combinations tried, in order: passenger/passenger (two
// hosts X, Y; X = Y collapses to a plain merge, reported as such by the
// caller), relay/relay (self-pair — the car is parked at the destination in
// between, free for others there), relay(out)/passenger(return) and
// passenger(out)/relay(return) (the relay leg pairs with another member's
// unpaired relay leg to the same destination, via relay.ts's pairing rule).
//
// This never mutates shared timelines: combination 4 (self-pair) probes a
// car's timeline with a tentative add + remove; combinations 2/3 only check
// that a compatible partner and hosts exist (the actual car reservation
// happens only if the Sadran accepts the suggestion).

import { fits, luggageFits } from './seatFit';
import { buildHostRides, findMergeHosts, type HostRide, type MergeCandidate } from './merge';
import { tryPair } from './relay';
import { roundTripOutLeg, roundTripReturnLeg, type NormalizedRequest } from './slots';
import type { CarTimeline } from './timeline';
import type { Assignment, Car, Destination, SolverConfig } from './types';

export interface SplitLegsContext {
  destinations: Record<string, Destination>;
  config: SolverConfig;
  cars: Map<string, Car>;
  assignments: Assignment[];
  hostDriverRequests: Map<string, NormalizedRequest>;
  /** final car timelines, keyed by carId */
  timelines: Map<string, CarTimeline>;
  /** relay one-way requests relay.ts could not pair (still available as split-leg partners) */
  unpairedRelay: NormalizedRequest[];
  home: string;
}

export interface SplitLegSide {
  hostRideId?: string;
  carMode: 'passenger' | 'relay';
  slot: number;
  carId?: string;
}

export interface SplitLegResult {
  outbound: SplitLegSide;
  return: SplitLegSide;
  cost: number;
  confidence: number;
}

function hosts(ctx: SplitLegsContext): HostRide[] {
  return buildHostRides(ctx.assignments, ctx.cars);
}

function passengerCombo(nr: NormalizedRequest, ctx: SplitLegsContext): SplitLegResult | null {
  const common = {
    destinations: ctx.destinations,
    config: ctx.config,
    cars: ctx.cars,
    hostDriverRequests: ctx.hostDriverRequests,
    hostTimelines: ctx.timelines,
    hosts: hosts(ctx),
  };
  const xCandidates: MergeCandidate[] = findMergeHosts({ guest: nr, leg: 'out', ...common });
  const yCandidates: MergeCandidate[] = findMergeHosts({ guest: nr, leg: 'return', ...common });
  const x = xCandidates[0];
  if (!x) return null;
  const y = yCandidates.find((c) => c.hostRideId !== x.hostRideId);
  if (!y) return null;
  return {
    outbound: { hostRideId: x.hostRideId, carMode: 'passenger', slot: nr.window.start },
    return: { hostRideId: y.hostRideId, carMode: 'passenger', slot: nr.window.end },
    cost: x.cost + y.cost,
    confidence: 0.6 * Math.min(x.confidence, y.confidence),
  };
}

function selfPairCombo(nr: NormalizedRequest, ctx: SplitLegsContext): SplitLegResult | null {
  const outLeg = roundTripOutLeg(nr, ctx.home);
  const retLeg = roundTripReturnLeg(nr, ctx.home);
  const sharedCars = [...ctx.cars.values()].filter((c) => c.type === 'shared').sort((a, b) => (a.id < b.id ? -1 : 1));

  for (const car of sharedCars) {
    if (!fits(car, nr.passengers) || !luggageFits(car, nr.luggage ? 1 : 0)) continue;
    const tl = ctx.timelines.get(car.id);
    if (!tl) continue;
    if (outLeg.window.end > retLeg.window.start) continue;
    if (!tl.isFree(outLeg.window, ctx.home)) continue;
    const probeId = `split-out:${nr.id}`;
    tl.add({ rideId: probeId, window: outLeg.window, startLocationId: ctx.home, endLocationId: nr.destinationId, overnightAck: false });
    const retFree = tl.isFree(retLeg.window, nr.destinationId);
    tl.remove(probeId);
    if (!retFree) continue;
    const idleSlots = retLeg.window.start - outLeg.window.end;
    return {
      outbound: { carMode: 'relay', slot: outLeg.window.start, carId: car.id },
      return: { carMode: 'relay', slot: retLeg.window.end, carId: car.id },
      cost: idleSlots,
      confidence: 1,
    };
  }
  return null;
}

function relayPassengerCombo(nr: NormalizedRequest, ctx: SplitLegsContext): SplitLegResult | null {
  const outLeg = roundTripOutLeg(nr, ctx.home);
  const synthOut: NormalizedRequest = {
    ...nr,
    legs: [outLeg],
    window: outLeg.window,
    minDurationSlots: nr.travelSlots,
    durationFixed: true,
  };
  const partner = ctx.unpairedRelay.find(
    (p) => p.destinationId === nr.destinationId && p.dayIndex === nr.dayIndex && p.legs[0]?.side === 'return' && tryPair(synthOut, p, [...ctx.cars.values()]),
  );
  if (!partner) return null;
  const yCandidates = findMergeHosts({
    guest: nr,
    leg: 'return',
    destinations: ctx.destinations,
    config: ctx.config,
    cars: ctx.cars,
    hostDriverRequests: ctx.hostDriverRequests,
    hostTimelines: ctx.timelines,
    hosts: hosts(ctx),
  });
  const y = yCandidates[0];
  if (!y) return null;
  return {
    outbound: { carMode: 'relay', slot: outLeg.window.start },
    return: { hostRideId: y.hostRideId, carMode: 'passenger', slot: nr.window.end },
    cost: y.cost,
    confidence: 0.6 * y.confidence,
  };
}

function passengerRelayCombo(nr: NormalizedRequest, ctx: SplitLegsContext): SplitLegResult | null {
  const retLeg = roundTripReturnLeg(nr, ctx.home);
  const synthRet: NormalizedRequest = {
    ...nr,
    legs: [retLeg],
    window: retLeg.window,
    minDurationSlots: nr.travelSlots,
    durationFixed: true,
  };
  const partner = ctx.unpairedRelay.find(
    (p) => p.destinationId === nr.destinationId && p.dayIndex === nr.dayIndex && p.legs[0]?.side === 'out' && tryPair(p, synthRet, [...ctx.cars.values()]),
  );
  if (!partner) return null;
  const xCandidates = findMergeHosts({
    guest: nr,
    leg: 'out',
    destinations: ctx.destinations,
    config: ctx.config,
    cars: ctx.cars,
    hostDriverRequests: ctx.hostDriverRequests,
    hostTimelines: ctx.timelines,
    hosts: hosts(ctx),
  });
  const x = xCandidates[0];
  if (!x) return null;
  return {
    outbound: { hostRideId: x.hostRideId, carMode: 'passenger', slot: nr.window.start },
    return: { carMode: 'relay', slot: retLeg.window.end },
    cost: x.cost,
    confidence: 0.6 * x.confidence,
  };
}

/** Tries the four combinations in order; returns the first that succeeds, or null. */
export function trySplitLegs(nr: NormalizedRequest, ctx: SplitLegsContext): SplitLegResult | null {
  if (nr.request.tripShape !== 'round_trip' || nr.request.needsCarAtDestination) return null;
  return (
    passengerCombo(nr, ctx) ?? relayPassengerCombo(nr, ctx) ?? passengerRelayCombo(nr, ctx) ?? selfPairCombo(nr, ctx)
  );
}
