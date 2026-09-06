// src/solver/merge.ts
//
// Merge candidate detection (docs/SOLVER.md §3.8). Merging is per leg: a
// 'both' guest needs a host ride covering both directions; an 'out' guest
// needs a host whose out leg goes there; a 'return' guest needs a host
// coming back from there. Merges are never applied automatically — only
// suggestions and informational mergeOpportunities are produced.
//
// Simplification (documented in docs/SOLVER.md §9): host-shift search is
// implemented only for 'both' (keep) hosts, by clamping the host's own
// window into the guest's declared flex and re-checking the host's own
// flex bounds and car timeline (fixed hosts never shift, per §1.3.5).
// hosts with no driverRequestId (an unassigned chauffeur ride) are skipped.

import { fits, luggageFits, sum } from './seatFit';
import type { NormalizedRequest } from './slots';
import { slotsToMinutes } from './slots';
import type { CarTimeline } from './timeline';
import type { Assignment, Car, Destination, LegSide, Passengers, SolverConfig, Window } from './types';

const ZONE_PENALTY_MINUTES = 10;

export interface HostRide {
  rideId: string;
  carId: string;
  window: Window;
  driverRequestId: string;
  legSide: LegSide;
  destinationId: string;
  passengers: Passengers;
  luggageCount: number;
  guestCount: number;
  isFixed: boolean;
  isTemporary: boolean;
}

export function buildHostRides(assignments: Assignment[], cars: Map<string, Car>): HostRide[] {
  const hosts: HostRide[] = [];
  for (const a of assignments) {
    const driverLeg = a.legs.find((l) => l.role === 'driver');
    if (!driverLeg || !a.driverRequestId) continue;
    const car = cars.get(a.carId);
    hosts.push({
      rideId: a.rideId,
      carId: a.carId,
      window: a.window,
      driverRequestId: a.driverRequestId,
      legSide: driverLeg.leg,
      destinationId: driverLeg.destinationId,
      passengers: a.passengers,
      luggageCount: a.luggageCount,
      guestCount: a.legs.filter((l) => l.role === 'passenger').length,
      isFixed: a.source === 'fixed',
      isTemporary: car?.type === 'temporary',
    });
  }
  return hosts;
}

function legCompatible(guestLeg: LegSide, hostLeg: LegSide): boolean {
  if (guestLeg === 'both') return hostLeg === 'both';
  if (guestLeg === 'out') return hostLeg === 'both' || hostLeg === 'out';
  return hostLeg === 'both' || hostLeg === 'return';
}

interface Detour {
  minutes: number;
  km: number;
}

function detourBetween(
  hostDestId: string,
  guestDestId: string,
  destinations: Record<string, Destination>,
  config: SolverConfig,
): Detour | null {
  if (hostDestId === guestDestId) return { minutes: 0, km: 0 };
  const h = destinations[hostDestId];
  const g = destinations[guestDestId];
  if (!h || !g || h.zone === 'unknown' || g.zone === 'unknown') return null;
  const travelH = h.travelMinutes ?? config.defaultTravelMinutes;
  const travelG = g.travelMinutes ?? config.defaultTravelMinutes;
  const km = Math.abs((h.distanceKm ?? 0) - (g.distanceKm ?? 0));
  if (h.zone === g.zone) return { minutes: Math.abs(travelH - travelG), km };
  const minutes = Math.abs(travelH - travelG) + ZONE_PENALTY_MINUTES;
  if (minutes > config.detour.maxMinutes || km > config.detour.maxKm) return null;
  return { minutes, km };
}

export interface MergeCandidate {
  hostRideId: string;
  carId: string;
  window: Window;
  hostShift?: { departureMin: number; returnMin: number };
  detourMinutes: number;
  detourKm: number;
  cost: number;
  confidence: number;
  proposedDriverRequestId: string;
}

export interface MergeSearchParams {
  guest: NormalizedRequest;
  leg: LegSide;
  hosts: HostRide[];
  destinations: Record<string, Destination>;
  config: SolverConfig;
  cars: Map<string, Car>;
  /** driver's own NormalizedRequest and timeline, for host-shift search (keyed by host rideId) */
  hostDriverRequests: Map<string, NormalizedRequest>;
  hostTimelines: Map<string, CarTimeline>;
}

function hostTimeCompatible(host: HostRide, guest: NormalizedRequest, leg: LegSide): boolean {
  if (leg === 'both') return host.window.start >= guest.flexDep[0] && host.window.start <= guest.flexDep[1] &&
    host.window.end >= guest.flexRet[0] && host.window.end <= guest.flexRet[1];
  if (leg === 'out') return host.window.start >= guest.flexDep[0] && host.window.start <= guest.flexDep[1];
  return host.window.end >= guest.flexRet[0] && host.window.end <= guest.flexRet[1];
}

function tryHostShift(
  host: HostRide,
  guest: NormalizedRequest,
  hostNr: NormalizedRequest | undefined,
  tl: CarTimeline | undefined,
): { window: Window; shift: { departureMin: number; returnMin: number } } | null {
  if (host.isFixed || host.legSide !== 'both' || !hostNr || !tl) return null;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const newStart = clamp(host.window.start, guest.flexDep[0], guest.flexDep[1]);
  const newEnd = clamp(host.window.end, guest.flexRet[0], guest.flexRet[1]);
  if (newEnd - newStart < hostNr.minDurationSlots) return null;
  if (newStart < hostNr.flexDep[0] || newStart > hostNr.flexDep[1]) return null;
  if (newEnd < hostNr.flexRet[0] || newEnd > hostNr.flexRet[1]) return null;
  if (newStart === host.window.start && newEnd === host.window.end) return null;
  tl.remove(host.rideId);
  const free = tl.isFree({ start: newStart, end: newEnd }, hostNr.legs[0]?.originId ?? '');
  tl.add({
    rideId: host.rideId,
    window: host.window,
    startLocationId: hostNr.legs[0]?.originId ?? '',
    endLocationId: hostNr.legs[0]?.destinationId ?? '',
    overnightAck: false,
  });
  if (!free) return null;
  return {
    window: { start: newStart, end: newEnd },
    shift: {
      departureMin: slotsToMinutes(newStart - host.window.start),
      returnMin: slotsToMinutes(newEnd - host.window.end),
    },
  };
}

export function findMergeHosts(params: MergeSearchParams): MergeCandidate[] {
  const { guest, leg, hosts, destinations, config, cars } = params;
  const candidates: MergeCandidate[] = [];

  for (const host of hosts) {
    if (!legCompatible(leg, host.legSide)) continue;
    const car = cars.get(host.carId);
    if (!car) continue;

    const detour = detourBetween(host.destinationId, guest.destinationId, destinations, config);
    if (!detour) continue;

    const combinedPassengers = sum(host.passengers, guest.passengers);
    const combinedLuggage = host.luggageCount + (guest.luggage ? 1 : 0);
    if (!fits(car, combinedPassengers) || !luggageFits(car, combinedLuggage)) continue;

    const hostNr = params.hostDriverRequests.get(host.rideId);
    let window = host.window;
    let hostShift: { departureMin: number; returnMin: number } | undefined;
    if (!hostTimeCompatible(host, guest, leg)) {
      const shifted = tryHostShift(host, guest, hostNr, params.hostTimelines.get(host.carId));
      if (!shifted) continue;
      window = shifted.window;
      hostShift = shifted.shift;
    }

    // REQ §13.9 / SOLVER §3.8: if the host doesn't need the car at the destination
    // but the guest does, the guest is proposed as driver instead of the host.
    const hostNeedsCar = hostNr?.request.needsCarAtDestination ?? true;
    const guestNeedsCar = guest.request.needsCarAtDestination;
    const proposedDriverRequestId = !hostNeedsCar && guestNeedsCar ? guest.id : host.driverRequestId;

    const shiftCostGuest = slotsToMinutes(Math.abs(window.start - guest.window.start)) +
      slotsToMinutes(Math.abs(window.end - guest.window.end));
    const shiftCostHost = hostShift ? Math.abs(hostShift.departureMin) + Math.abs(hostShift.returnMin) : 0;
    const cost = detour.minutes + shiftCostGuest + shiftCostHost;
    const confidence = Math.max(
      0,
      1 - 0.4 * (detour.minutes / Math.max(1, config.detour.maxMinutes)) - 0.1 * host.guestCount - shiftCostGuest / 480,
    );

    candidates.push({
      hostRideId: host.rideId,
      carId: host.carId,
      window,
      hostShift,
      detourMinutes: detour.minutes,
      detourKm: detour.km,
      cost,
      confidence,
      proposedDriverRequestId,
    });
  }

  candidates.sort((a, b) => a.cost - b.cost || (a.hostRideId < b.hostRideId ? -1 : 1));
  return candidates;
}
