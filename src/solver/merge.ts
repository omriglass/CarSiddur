// src/solver/merge.ts
//
// Merge candidate detection (docs/SOLVER.md §3.8). Merging is per leg: a
// 'both' guest needs a host ride covering both directions; an 'out' guest
// needs a host whose out leg goes there; a 'return' guest needs a host
// coming back from there. Merges are never applied automatically — only
// suggestions and informational mergeOpportunities are produced.
//
// REQUIREMENTS §13.95 (H1): the guest's boarding and alighting places are
// inserted into the host's leg route by cheapest insertion (boarding strictly
// before the host's final destination, alighting at or before it, added driving
// per leg within the detour limit); the host's window then starts earlier /
// ends later by the added driving. A non-fixed 'both' host may additionally
// shift within its own flexibility so the guest's time fits. Hosts with no
// driverRequestId (an unassigned chauffeur ride) are skipped.

import { fits, luggageFits, sum } from './seatFit';
import type { NormalizedRequest } from './slots';
import { slotsToMinutes } from './slots';
import type { CarTimeline } from './timeline';
import { legRoute, resolveStopMinutes, travelBetween, type RouteStop, type TravelLookup } from './travel';
import type { Assignment, AssignmentLeg, Car, Destination, LegSide, Passengers, Request, SolverConfig, TravelEdge, Window } from './types';

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
  /** Where the guest boards: a place already on the host's route, or an inserted stop. */
  boardAtLocationId?: string;
  /** REQUIREMENTS §13.95 (H1): the host ride's window before the merge (`window` is the new one:
   *  it starts earlier by `addedOutMinutes`, ends later by `addedReturnMinutes`). */
  hostWindowBefore?: Window;
  /** Added driving per leg (minutes, rounded up to slots in the window) — 0 when that leg is not merged. */
  addedOutMinutes?: number;
  addedReturnMinutes?: number;
  /** R6B5: the one-way guest rides the host's return leg (its own request leg is still 'out'). */
  reversedOneWay?: boolean;
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
  /** For `legRoute()`/`travelBetween()` (cheapest insertion, REQUIREMENTS §13.95). */
  homeLocationId: string;
  travel?: TravelEdge[];
}

// --- REQUIREMENTS §13.95 (H1): cheapest insertion of the guest's boarding/alighting ---

interface Insertion {
  addedMinutes: number;
  /** undefined when any hop's distance is unknown */
  addedKm: number | undefined;
  /** minutes from the route start to arriving at the boarding node */
  boardArrivalMinutes: number;
  /** minutes from arriving at the alighting node to the route end */
  alightTailMinutes: number;
  /** minutes from arriving at the boarding node to the route end (R6B5: a reversed one-way guest is timed by its boarding on the return leg) */
  boardTailMinutes: number;
}

interface RouteCost {
  /** total minutes incl. dwell at every stop */
  minutes: number;
  km: number | undefined;
  /** arrival[i] = minutes from the route start to arriving at node i */
  arrival: number[];
}

function routeCost(lookup: TravelLookup, route: RouteStop[], stopMinutes: number): RouteCost {
  let t = 0;
  let km: number | undefined = 0;
  const arrival: number[] = [0];
  for (let i = 0; i < route.length - 1; i++) {
    const x = route[i] as RouteStop;
    const y = route[i + 1] as RouteStop;
    if (!x.locationId || !y.locationId) {
      t += lookup.config.defaultTravelMinutes;
      km = undefined;
    } else {
      const hop = travelBetween(lookup, x.locationId, y.locationId);
      t += hop.minutes;
      km = km === undefined || hop.km === undefined ? undefined : km + hop.km;
    }
    arrival.push(t);
    if (i + 1 < route.length - 1) t += stopMinutes;
  }
  return { minutes: t, km, arrival };
}

/**
 * Cheapest insertion of boarding place `a` and alighting place `b` (in travel
 * order) into the host's leg route. `a` must sit strictly before the route's
 * final node; `b` after `a` and at or before the final node. A place already on
 * the route is used as is (never duplicated), so a place equal to the final node
 * can only be the alighting place. Null when impossible or over the detour limit
 * (minutes always; km when every hop's distance is known).
 */
function cheapestInsertion(
  lookup: TravelLookup,
  route: RouteStop[],
  a: string,
  b: string,
  stopMinutes: number,
  limits: { maxMinutes: number; maxKm: number },
): Insertion | null {
  const last = route.length - 1;
  const base = routeCost(lookup, route, stopMinutes);
  const idxA = route.findIndex((r) => r.locationId === a);
  const idxB = route.findIndex((r) => r.locationId === b);
  if (idxA === last) return null;
  if (idxA !== -1 && idxB !== -1 && idxB <= idxA) return null;
  let best: Insertion | null = null;
  const boardEdges = idxA !== -1 ? [-1] : Array.from({ length: last }, (_, i) => i);
  for (const be of boardEdges) {
    const withA = be === -1 ? route : [...route.slice(0, be + 1), { locationId: a }, ...route.slice(be + 1)];
    const aIdx = be === -1 ? idxA : be + 1;
    const existingB = withA.findIndex((r) => r.locationId === b);
    const alightEdges = existingB !== -1 ? [-1] : Array.from({ length: withA.length - 1 - aIdx }, (_, k) => aIdx + k);
    for (const ae of alightEdges) {
      const full = ae === -1 ? withA : [...withA.slice(0, ae + 1), { locationId: b }, ...withA.slice(ae + 1)];
      const bIdx = ae === -1 ? existingB : ae + 1;
      if (bIdx <= aIdx) continue;
      const cost = routeCost(lookup, full, stopMinutes);
      const added = Math.max(0, cost.minutes - base.minutes);
      const addedKm = cost.km === undefined || base.km === undefined ? undefined : Math.max(0, cost.km - base.km);
      if (added > limits.maxMinutes) continue;
      if (addedKm !== undefined && addedKm > limits.maxKm) continue;
      if (best && best.addedMinutes <= added) continue;
      best = {
        addedMinutes: added,
        addedKm,
        boardArrivalMinutes: cost.arrival[aIdx] as number,
        alightTailMinutes: cost.minutes - (cost.arrival[bIdx] as number),
        boardTailMinutes: cost.minutes - (cost.arrival[aIdx] as number),
      };
    }
  }
  return best;
}

const slotsCeil = (minutes: number): number => (minutes <= 0 ? 0 : Math.ceil(minutes / 15));

/** One merged direction of a candidate. */
interface Side {
  insertion: Insertion;
  addedSlots: number;
}

function sideFor(
  params: MergeSearchParams,
  hostRequest: Pick<Request, 'originId' | 'destinationId' | 'stops'>,
  guest: NormalizedRequest,
  dir: 'out' | 'return',
  forward = dir === 'out',
): Side | null {
  const lookup: TravelLookup = { travel: params.travel, homeLocationId: params.homeLocationId, destinations: params.destinations, config: params.config };
  const route = legRoute(lookup, hostRequest, dir);
  // the guest travels origin -> destination on 'out', destination -> origin on 'return';
  // `forward` (R6B5, a reversed one-way guest) rides the host's return leg origin -> destination.
  const a = forward ? guest.originId : guest.destinationId;
  const b = forward ? guest.destinationId : guest.originId;
  const insertion = cheapestInsertion(lookup, route, a, b, resolveStopMinutes(params.config), params.config.detour);
  if (!insertion) return null;
  return { insertion, addedSlots: slotsCeil(insertion.addedMinutes) };
}

export function findMergeHosts(params: MergeSearchParams): MergeCandidate[] {
  const { guest, leg, hosts, cars } = params;
  const candidates: MergeCandidate[] = [];

  for (const host of hosts) {
    // REQ §13.99: only a private car's owner puts requests on it — never merge anyone into a temporary car's ride.
    if (host.isTemporary) continue;
    if (!legCompatible(leg, host.legSide)) continue;
    const car = cars.get(host.carId);
    if (!car) continue;

    const combinedPassengers = sum(host.passengers, guest.passengers);
    const combinedLuggage = host.luggageCount + (guest.luggage ? 1 : 0);
    if (!fits(car, combinedPassengers) || !luggageFits(car, combinedLuggage)) continue;

    const hostNr = params.hostDriverRequests.get(host.rideId);
    const hostRequest: Pick<Request, 'originId' | 'destinationId' | 'stops'> = hostNr
      ? hostNr.request
      : { originId: host.originId, destinationId: host.requestDestinationId };

    // R6B5 (SQL `_merge_guest_swapped`, TS `isReversedOneWay`): a one-way guest that is exactly the reverse of a
    // round-trip host (boards where the host's out leg ends, alights where its return leg ends) rides the host's return leg.
    const lookup: TravelLookup = { travel: params.travel, homeLocationId: params.homeLocationId, destinations: params.destinations, config: params.config };
    const hostOutRoute = legRoute(lookup, hostRequest, 'out');
    const hostReturnRoute = legRoute(lookup, hostRequest, 'return');
    const reversed = leg === 'out' && guest.request.tripShape === 'one_way_to' && host.legSide === 'both'
      && !!guest.originId && !!guest.destinationId
      && guest.originId === hostOutRoute[hostOutRoute.length - 1]?.locationId
      && guest.destinationId === hostReturnRoute[hostReturnRoute.length - 1]?.locationId;
    const mergesOut = !reversed && (leg === 'out' || leg === 'both');
    const mergesReturn = reversed || leg === 'return' || leg === 'both';
    const out = mergesOut ? sideFor(params, hostRequest, guest, 'out') : null;
    const ret = mergesReturn ? sideFor(params, hostRequest, guest, 'return', reversed) : null;
    if ((mergesOut && !out) || (mergesReturn && !ret)) continue;
    const addOut = out?.addedSlots ?? 0;
    const addRet = ret?.addedSlots ?? 0;

    // Guest-time check at the boarding ETA (out) / arrival at the guest's own place (return),
    // anchored at the host's *new* window. Shift the host (non-fixed 'both' hosts only) when it misses.
    const etaOutOf = (baseStart: number) => baseStart - addOut + Math.round((out?.insertion.boardArrivalMinutes ?? 0) / 15);
    // A reversed one-way guest is timed by its BOARDING on the return leg against its own departure window.
    const retTail = reversed ? (ret?.insertion.boardTailMinutes ?? 0) : (ret?.insertion.alightTailMinutes ?? 0);
    const retFlex = reversed ? guest.flexDep : guest.flexRet;
    const etaRetOf = (baseEnd: number) => baseEnd + addRet - Math.round(retTail / 15);
    const okOut = !out || (etaOutOf(host.window.start) >= guest.flexDep[0] && etaOutOf(host.window.start) <= guest.flexDep[1]);
    const okRet = !ret || (etaRetOf(host.window.end) >= retFlex[0] && etaRetOf(host.window.end) <= retFlex[1]);

    // REQ §13.112 (c): a ride serving a window request keeps its length — a merge that adds driving would grow it.
    if (hostNr?.durationLocked && (addOut > 0 || addRet > 0)) continue;

    let baseStart = host.window.start;
    let baseEnd = host.window.end;
    let hostShift: { departureMin: number; returnMin: number } | undefined;
    if (!okOut || !okRet) {
      if (host.isFixed || host.legSide !== 'both' || !hostNr) continue;
      const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
      const bootOut = Math.round((out?.insertion.boardArrivalMinutes ?? 0) / 15);
      const tailRet = Math.round(retTail / 15);
      if (hostNr.durationLocked) {
        // REQ §13.112 (c): a window host moves as one block — one shift `s` serves both guest legs.
        let lo = -Infinity;
        let hi = Infinity;
        if (out) { lo = Math.max(lo, guest.flexDep[0] + addOut - bootOut - baseStart); hi = Math.min(hi, guest.flexDep[1] + addOut - bootOut - baseStart); }
        if (ret) { lo = Math.max(lo, retFlex[0] - addRet + tailRet - baseEnd); hi = Math.min(hi, retFlex[1] - addRet + tailRet - baseEnd); }
        if (lo > hi) continue;
        const s = clamp(0, lo, hi);
        baseStart += s;
        baseEnd += s;
      } else {
        if (out) baseStart = clamp(baseStart, guest.flexDep[0] + addOut - bootOut, guest.flexDep[1] + addOut - bootOut);
        if (ret) baseEnd = clamp(baseEnd, retFlex[0] - addRet + tailRet, retFlex[1] - addRet + tailRet);
      }
      if (baseEnd - baseStart < hostNr.minDurationSlots) continue;
      if (baseStart < hostNr.flexDep[0] || baseStart > hostNr.flexDep[1]) continue;
      if (baseEnd < hostNr.flexRet[0] || baseEnd > hostNr.flexRet[1]) continue;
      hostShift = {
        departureMin: slotsToMinutes(baseStart - host.window.start),
        returnMin: slotsToMinutes(baseEnd - host.window.end),
      };
    }
    const window: Window = { start: baseStart - addOut, end: baseEnd + addRet };
    if (window.start < 0) continue;

    // the extended / shifted window must still be free on the host's car
    if (window.start !== host.window.start || window.end !== host.window.end) {
      const tl = params.hostTimelines.get(host.carId);
      const block = tl?.allBlocks().find((x) => x.rideId === host.rideId);
      if (tl && block) {
        tl.remove(host.rideId);
        const free = tl.isFree(window, block.startLocationId, block.relayPairId, block.endLocationId);
        tl.restore(block, host.isFixed);
        if (!free) continue;
      }
    }

    // REQ §13.9 / SOLVER §3.8: if the host doesn't need the car at the destination
    // but the guest does, the guest is proposed as driver instead of the host.
    const hostNeedsCar = hostNr?.request.needsCarAtDestination ?? true;
    const guestNeedsCar = guest.request.needsCarAtDestination;
    const proposedDriverRequestId = !hostNeedsCar && guestNeedsCar ? guest.id : host.driverRequestId;

    const detourMinutes = Math.max(out?.insertion.addedMinutes ?? 0, ret?.insertion.addedMinutes ?? 0);
    const kmOut = out?.insertion.addedKm;
    const kmRet = ret?.insertion.addedKm;
    const detourKm = Math.max(kmOut ?? 0, kmRet ?? 0);
    const guestStartEta = out ? etaOutOf(baseStart) : undefined;
    const guestEndEta = ret ? etaRetOf(baseEnd) : undefined;
    // REQ §13.112 (c): a window guest needs the whole block's time away — boarding to alighting may not be shorter.
    if (guest.durationLocked) {
      if (guestStartEta === undefined || guestEndEta === undefined || guestEndEta - guestStartEta < guest.window.end - guest.window.start) continue;
    }
    const shiftCostGuest =
      (guestStartEta === undefined ? 0 : slotsToMinutes(Math.abs(guestStartEta - guest.window.start))) +
      (guestEndEta === undefined ? 0 : slotsToMinutes(Math.abs(guestEndEta - (reversed ? guest.window.start : guest.window.end))));
    const shiftCostHost = hostShift ? Math.abs(hostShift.departureMin) + Math.abs(hostShift.returnMin) : 0;
    const addedTotal = (out?.insertion.addedMinutes ?? 0) + (ret?.insertion.addedMinutes ?? 0);
    const cost = addedTotal + shiftCostGuest + shiftCostHost;
    const confidence = Math.max(
      0,
      1 - 0.4 * (detourMinutes / Math.max(1, params.config.detour.maxMinutes)) - 0.1 * host.guestCount - shiftCostGuest / 480,
    );

    candidates.push({
      hostRideId: host.rideId,
      carId: host.carId,
      window,
      hostShift,
      detourMinutes,
      detourKm,
      cost,
      confidence,
      proposedDriverRequestId,
      boardAtLocationId: leg === 'return' ? guest.destinationId : guest.originId,
      reversedOneWay: reversed || undefined,
      hostWindowBefore: window.start !== host.window.start || window.end !== host.window.end ? host.window : undefined,
      addedOutMinutes: out && out.insertion.addedMinutes > 0 ? out.insertion.addedMinutes : undefined,
      addedReturnMinutes: ret && ret.insertion.addedMinutes > 0 ? ret.insertion.addedMinutes : undefined,
    });
  }

  candidates.sort((a, b) => a.cost - b.cost || (a.hostRideId < b.hostRideId ? -1 : 1));
  return candidates;
}
