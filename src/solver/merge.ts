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
import { legRoute, resolveStopMinutes, routeEtaAt, type TravelLookup } from './travel';
import type { Assignment, AssignmentLeg, Car, Destination, LegSide, Passengers, Request, SolverConfig, TravelEdge, Window } from './types';

const ZONE_PENALTY_MINUTES = 10;

export interface HostRide {
  rideId: string;
  carId: string;
  window: Window;
  driverRequestId: string;
  legSide: LegSide;
  destinationId: string;
  /** The host request's own declared origin (REQUIREMENTS §13.93) — a 'return' leg's
   *  physical travel origin is the destination, but the *request's* origin is where it
   *  ends (home/origin); derived from the AssignmentLeg so it works for fixed rides too. */
  originId: string;
  /** The host request's own far/declared destination (REQUIREMENTS §13.93, ORIGINS_PLAN
   *  §6.3, mirrors `originId` above): for a 'return' leg this is the leg's physical
   *  *origin* (the far place); for 'out'/'both' it's the leg's physical destination.
   *  Used only as the multi-stop route fallback when no NormalizedRequest is available
   *  (a fixed-ride host, whose own `.stops` the solver never sees). */
  requestDestinationId: string;
  passengers: Passengers;
  luggageCount: number;
  guestCount: number;
  isFixed: boolean;
  isTemporary: boolean;
}

/** The host *request's* own origin, derived from its driver leg (REQUIREMENTS §13.93):
 *  for 'out'/'both' this is the leg's physical originId; for 'return' (destination -> origin)
 *  it's the leg's destinationId. */
function requestOriginOfLeg(leg: AssignmentLeg): string {
  return leg.leg === 'return' ? leg.destinationId : leg.originId;
}

/** The host *request's* own far/declared destination, mirroring `requestOriginOfLeg`
 *  (REQUIREMENTS §13.93, ORIGINS_PLAN §6.3): for 'return' this is the leg's physical
 *  originId (the far place the car is coming back from); for 'out'/'both' it's the
 *  leg's physical destinationId. */
function requestDestinationOfLeg(leg: AssignmentLeg): string {
  return leg.leg === 'return' ? leg.originId : leg.destinationId;
}

export function buildHostRides(assignments: Assignment[], cars: Map<string, Car>): HostRide[] {
  const hosts: HostRide[] = [];
  for (const a of assignments) {
    // Multi-day series legs are never merge hosts (SOLVER §3.x): immovable,
    // and every gap around them is already fully occupied by the series itself.
    if (a.seriesId) continue;
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
      originId: requestOriginOfLeg(driverLeg),
      requestDestinationId: requestDestinationOfLeg(driverLeg),
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
  /** Multi-stop rides (REQUIREMENTS §13.93, ORIGINS_PLAN §6.3): where the guest boards —
   *  the host's own origin in the same-origin case, or one of its declared stops. */
  boardAtLocationId?: string;
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
  /** REQUIREMENTS §13.93, ORIGINS_PLAN §6.3: for `legRoute()`/`travelBetween()` (an 'out'/
   *  'return' guest leg's route-based join). Not needed for a 'both' guest leg (unchanged
   *  same-origin + destination/zone detour heuristic, which never consults stops). */
  homeLocationId: string;
  travel?: TravelEdge[];
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

/**
 * Multi-stop rides (REQUIREMENTS §13.93 "Multi-stop rides", ORIGINS_PLAN
 * §6.3): tries to board the guest's `leg` ('out' or 'return' only — a 'both'
 * guest keeps the plain same-origin + detour heuristic below unchanged) at
 * any point on the host's own route for that direction, not just at its
 * origin. `a`/`b` are the guest's own boarding/alighting places (an 'out'
 * guest travels origin -> destination; a 'return' guest travels destination
 * -> origin); the host qualifies when both appear on its route with
 * `index(a) < index(b)` and the host's ETA at `a` (the relevant edge for the
 * matched direction) falls inside the guest's own declared flexibility.
 * Returns null when the host has no stops that help (a plain two-node route,
 * `[origin, destination]`) and the exact endpoints don't match either — the
 * caller then falls back to the pre-existing same-origin/detour heuristic,
 * so a same-zone-but-different-destination merge (no stops involved at all)
 * keeps working exactly as before.
 */
function tryRouteMatch(
  host: HostRide,
  guest: NormalizedRequest,
  leg: 'out' | 'return',
  params: MergeSearchParams,
  car: Car,
): MergeCandidate | null {
  const hostNr = params.hostDriverRequests.get(host.rideId);
  const hostRequestLike: Pick<Request, 'originId' | 'destinationId' | 'stops'> = hostNr
    ? hostNr.request
    : { originId: host.originId, destinationId: host.requestDestinationId };
  const lookup: TravelLookup = { travel: params.travel, homeLocationId: params.homeLocationId, destinations: params.destinations, config: params.config };
  const stopMinutes = resolveStopMinutes(params.config);
  const route = legRoute(lookup, hostRequestLike, leg);

  const a = leg === 'out' ? guest.originId : guest.destinationId;
  const b = leg === 'out' ? guest.destinationId : guest.originId;
  const idxA = route.findIndex((r) => r.locationId === a);
  const idxB = route.findIndex((r) => r.locationId === b);
  if (idxA === -1 || idxB === -1 || idxA >= idxB) return null;

  const anchor = leg === 'out' ? host.window.start : host.window.end;
  // The relevant time check mirrors the pre-existing hostTimeCompatible()
  // convention (departure for 'out', arrival-at-own-origin for 'return'):
  // the ETA at `a` for an out guest (they board and leave at their own
  // declared departure flex), the ETA at `b` for a return guest (they care
  // about arriving home within their declared return flex).
  const checkLocationId = leg === 'out' ? a : b;
  const checkSlot = routeEtaAt(lookup, hostRequestLike, leg, anchor, stopMinutes, checkLocationId);
  if (checkSlot === undefined) return null;
  const flexBound = leg === 'out' ? guest.flexDep : guest.flexRet;
  if (checkSlot < flexBound[0] || checkSlot > flexBound[1]) return null;

  const combinedPassengers = sum(host.passengers, guest.passengers);
  const combinedLuggage = host.luggageCount + (guest.luggage ? 1 : 0);
  if (!fits(car, combinedPassengers) || !luggageFits(car, combinedLuggage)) return null;

  const hostNeedsCar = hostNr?.request.needsCarAtDestination ?? true;
  const guestNeedsCar = guest.request.needsCarAtDestination;
  const proposedDriverRequestId = !hostNeedsCar && guestNeedsCar ? guest.id : host.driverRequestId;

  const guestPreferred = leg === 'out' ? guest.window.start : guest.window.end;
  const shiftCostGuest = slotsToMinutes(Math.abs(checkSlot - guestPreferred));
  const confidence = Math.max(0, 1 - 0.1 * host.guestCount - shiftCostGuest / 480);

  return {
    hostRideId: host.rideId,
    carId: host.carId,
    window: host.window,
    // The guest boards exactly on the host's own route — no physical detour.
    detourMinutes: 0,
    detourKm: 0,
    cost: shiftCostGuest,
    confidence,
    proposedDriverRequestId,
    boardAtLocationId: a,
  };
}

export function findMergeHosts(params: MergeSearchParams): MergeCandidate[] {
  const { guest, leg, hosts, destinations, config, cars } = params;
  const candidates: MergeCandidate[] = [];

  for (const host of hosts) {
    if (!legCompatible(leg, host.legSide)) continue;
    const car = cars.get(host.carId);
    if (!car) continue;

    if (leg !== 'both') {
      const routeCandidate = tryRouteMatch(host, guest, leg, params, car);
      if (routeCandidate) {
        candidates.push(routeCandidate);
        continue;
      }
    }

    // REQUIREMENTS §13.93, ORIGINS_PLAN §4 item 5: merges only between
    // requests that share the same origin — a no-op filter for every
    // legacy (home-origin) request, since every host/guest origin defaults
    // to the same department home. The same-origin case is "boarding = host
    // origin" (ORIGINS_PLAN §6.3), already covered by tryRouteMatch above for
    // an 'out'/'return' guest leg; this is the remaining fallback — a 'both'
    // guest leg (never routed), or an 'out'/'return' guest whose destination
    // isn't literally on the host's route but is zone/detour-compatible.
    if (host.originId !== guest.originId) continue;

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
      boardAtLocationId: host.originId,
      proposedDriverRequestId,
    });
  }

  candidates.sort((a, b) => a.cost - b.cost || (a.hostRideId < b.hostRideId ? -1 : 1));
  return candidates;
}
