// src/solver/travel.ts
//
// Origin helpers (REQUIREMENTS §13.93, docs/ORIGINS_PLAN_2026-10.md §4).
// `originIdOf` resolves a request's declared origin (undefined = department
// home); `effectiveTripType` derives the new three-way trip type from the
// legacy fields exactly as the SQL backfill does, so every existing
// request/fixture that never set `tripType` keeps behaving exactly as
// before; `travelBetween` is the one place that turns an (origin,
// destination) pair into a travel estimate, replacing direct
// `destinations[id].travelMinutes` lookups for leg travel.

import type { Destination, Request, SolverConfig, TravelEdge, TripType, Window } from './types';

/** `request.originId`, or the department home when unset (the only value every request had before this field existed). */
export function originIdOf(request: Pick<Request, 'originId'>, homeLocationId: string): string {
  return request.originId ?? homeLocationId;
}

/**
 * Derives the new three-way trip type from the legacy fields (REQUIREMENTS
 * §13.93): an explicit `tripType` always wins. Otherwise: any one-way shape,
 * or a round trip with `needsCarAtDestination = false`, is `drop_off`
 * (today's relay/chauffeur/passenger handling, now origin-aware); everything
 * else is `round_trip`. No legacy combination of fields ever derives the new
 * `one_way` value — only an explicit `tripType: 'one_way'` does (a bridge
 * concern, O5), so every existing golden fixture and the one-way pairing
 * parity suite are unaffected by this function's existence.
 */
export function effectiveTripType(request: Pick<Request, 'tripType' | 'tripShape' | 'needsCarAtDestination'>): TripType {
  if (request.tripType) return request.tripType;
  if (request.tripShape !== 'round_trip') return 'drop_off';
  if (!request.needsCarAtDestination) return 'drop_off';
  return 'round_trip';
}

export interface TravelResult {
  minutes: number;
  km?: number;
}

export interface TravelLookup {
  travel?: TravelEdge[];
  homeLocationId: string;
  destinations: Record<string, Destination>;
  config: Pick<SolverConfig, 'defaultTravelMinutes'>;
}

/**
 * Pure travel estimate between two location ids (REQUIREMENTS §13.93,
 * ORIGINS_PLAN §4): the same place is 0/0; an explicit `SolverInput.travel`
 * row (either direction) wins next; home <-> X falls back to X's own
 * `Destination.travelMinutes`/`distanceKm` (today's only lookup, preserved
 * exactly for every home-origin leg); anything else falls back to
 * `config.defaultTravelMinutes` with `km` left undefined.
 */
export function travelBetween(input: TravelLookup, fromId: string, toId: string): TravelResult {
  if (fromId === toId) return { minutes: 0, km: 0 };
  const row = (input.travel ?? []).find(
    (e) => (e.fromId === fromId && e.toId === toId) || (e.fromId === toId && e.toId === fromId),
  );
  if (row) return { minutes: row.travelMinutes ?? input.config.defaultTravelMinutes, km: row.distanceKm };
  const home = input.homeLocationId;
  if (fromId === home || toId === home) {
    const other = fromId === home ? toId : fromId;
    const dest = input.destinations[other];
    if (dest) return { minutes: dest.travelMinutes ?? input.config.defaultTravelMinutes, km: dest.distanceKm };
  }
  return { minutes: input.config.defaultTravelMinutes, km: undefined };
}

export interface ChauffeurCandidate {
  window: Window;
  /** where the car must be, and ends up, for this candidate (REQUIREMENTS §13.93, ORIGINS_PLAN §3) */
  carOriginId: string;
}

/**
 * Chauffeur window(s) for a leg `A -> B` (`originId -> destinationId`) at
 * clock point `point` — `D` (departure) for an `out` leg, `R` (arrival) for a
 * `return` leg — depending on where the car actually is (REQUIREMENTS
 * §13.93, owner follow-up 2026-10-04, ORIGINS_PLAN §3). An `out` leg has
 * **two** candidates, tried in this order:
 *  1. the car is at `A` (drop-off): `[D, D + routeSlots + directSlots + dwell)`
 *     — the car drives the requester's own route `A -> ... -> B` (`routeSlots`,
 *     multi-stop-aware, REQUIREMENTS §13.93 "Multi-stop rides"), then drives
 *     straight back `B -> A` empty (`directSlots`, never revisits the stops).
 *     With no stops `routeSlots === directSlots`, byte-identical to the old
 *     `2·travel + dwell` formula.
 *  2. the car is at `B` (pickup, e.g. "pick me up from Harish" with origin
 *     Harish/A and destination Givat Haviva/B where the car sits): the car
 *     drives straight to `A` empty first (`directSlots + dwell` before `D`),
 *     then at `D` drives the requester's own route `A -> ... -> B`
 *     (`routeSlots` after `D`).
 * A `return` leg keeps the legacy single formula (now route-aware the same
 * way), anchored at the request's own origin (owner 2026-10-04: "legacy
 * return legs keep their current formula") —
 * `[R − routeSlots − directSlots − dwell, R)`.
 */
export function chauffeurCandidates(
  side: 'out' | 'return',
  point: number,
  routeSlots: number,
  directSlots: number,
  dwellSlots: number,
  originId: string,
  destinationId: string,
  /** R8B13: the ride's whole duration in slots, rounded once from exact minutes
   *  (`chauffeurTotalSlots`). Absent = the old per-part slot sum. */
  totalSlots?: number,
): ChauffeurCandidate[] {
  const total = totalSlots ?? routeSlots + directSlots + dwellSlots;
  if (side === 'return') {
    return [{ window: { start: point - total, end: point }, carOriginId: originId }];
  }
  return [
    { window: { start: point, end: point + total }, carOriginId: originId },
    // Pickup: the ride ends when the car is back at B (D + the route), same total duration.
    { window: { start: point + routeSlots - total, end: point + routeSlots }, carOriginId: destinationId },
  ];
}

/**
 * R8B13 — THE chauffeur-ride duration rule, shared with SQL `chauffeur_ride_minutes()` (which the
 * hand placement `place_request_on_car` uses): `ceil((route + direct + dwell) / 15) * 15` minutes,
 * rounded ONCE from exact minutes (never per part: 31 min + 31 min + 10 min is 75, not 7 slots).
 * `route` = the leg's own route minutes (stops included), `direct` = the empty drive back
 * `origin <-> destination` (equal to `route` with no stops), `dwell` = `chauffeurDwellMinutes`.
 */
export function chauffeurTotalSlots(
  lookup: TravelLookup,
  request: Pick<Request, 'originId' | 'destinationId' | 'stops'>,
  side: 'out' | 'return',
  originId: string,
  destinationId: string,
  stopMinutes: number,
  dwellMinutes: number,
): number {
  const route = legRouteMinutes(lookup, request, side, stopMinutes);
  const direct = travelBetween(lookup, originId, destinationId).minutes;
  return Math.max(1, Math.ceil((route + direct + Math.max(0, dwellMinutes)) / 15));
}

// --- Multi-stop rides (REQUIREMENTS §13.93 "Multi-stop rides", ORIGINS_PLAN §6.2/§6.3) ---

/** Default `department_settings.stop_minutes` when the bridge hasn't wired the setting through. */
export function resolveStopMinutes(config: Pick<SolverConfig, 'stopMinutes'>): number {
  return config.stopMinutes ?? 5;
}

/** One waypoint of a leg's route. `locationId` undefined = a free-text stop: never matched by
 *  merge joining, and the hops touching it always use `config.defaultTravelMinutes` (never a
 *  real `travelBetween` lookup, since there is no place id to look up). */
export interface RouteStop {
  locationId?: string;
}

/**
 * Ordered route of one leg (ORIGINS_PLAN §6.2): `out` = origin -> out-stops ->
 * destination; `return` = destination -> return-stops -> origin. Stop order
 * is array order filtered by `leg` (`Request.stops` carries no separate
 * position field). With no stops this is just the two endpoints, so every
 * other route helper below reduces to today's single-hop behavior exactly.
 */
export function legRoute(
  lookup: Pick<TravelLookup, 'homeLocationId'>,
  request: Pick<Request, 'originId' | 'destinationId' | 'stops'>,
  leg: 'out' | 'return',
): RouteStop[] {
  const origin: RouteStop = { locationId: originIdOf(request, lookup.homeLocationId) };
  const destination: RouteStop = { locationId: request.destinationId };
  const stops: RouteStop[] = (request.stops ?? [])
    .filter((s) => s.leg === leg)
    .map((s) => ({ locationId: s.locationId }));
  return leg === 'out' ? [origin, ...stops, destination] : [destination, ...stops, origin];
}

function hopMinutes(lookup: TravelLookup, a: RouteStop, b: RouteStop): number {
  if (!a.locationId || !b.locationId) return lookup.config.defaultTravelMinutes;
  return travelBetween(lookup, a.locationId, b.locationId).minutes;
}

/**
 * Total minutes of a leg's route: Σ travel(consecutive hops) + `stopMinutes`
 * × number of stops on that leg (ORIGINS_PLAN §6.2). With no stops this is
 * exactly `travelBetween(origin, destination).minutes` — today's only
 * formula, unchanged.
 */
export function legRouteMinutes(
  lookup: TravelLookup,
  request: Pick<Request, 'originId' | 'destinationId' | 'stops'>,
  leg: 'out' | 'return',
  stopMinutes: number,
): number {
  const route = legRoute(lookup, request, leg);
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) total += hopMinutes(lookup, route[i] as RouteStop, route[i + 1] as RouteStop);
  const stopCount = Math.max(0, route.length - 2);
  return total + stopMinutes * stopCount;
}

/** `legRouteMinutes()` rounded outward to the 15-minute grid (never 0) — the drop-in
 *  replacement for the old single-hop `travelSlotsFor()` wherever a leg's own duration
 *  (not an empty repositioning drive) is needed. */
export function legRouteSlots(
  lookup: TravelLookup,
  request: Pick<Request, 'originId' | 'destinationId' | 'stops'>,
  leg: 'out' | 'return',
  stopMinutes: number,
): number {
  return Math.max(1, Math.ceil(legRouteMinutes(lookup, request, leg, stopMinutes) / 15));
}

export interface StopEta {
  locationId?: string;
  slot: number;
}

/**
 * ETA (in slots) at each stop of a leg's route, in leg/position order
 * (ORIGINS_PLAN §6.2, mirrors SQL `request_stop_etas`): `out` ETAs count
 * forward from `anchorSlot` (the departure slot); `return` ETAs count
 * backward from `anchorSlot` (the arrival slot at the leg's own origin). A
 * free-text stop still gets an ETA (the hops touching it just use
 * `defaultTravelMinutes`); only the *matching* of a free-text stop (merge
 * joining) is ever disabled, never its ETA. Never includes the route's own
 * origin/destination endpoints — see `routeEtaAt()` for those.
 */
export function stopEtas(
  lookup: TravelLookup,
  request: Pick<Request, 'originId' | 'destinationId' | 'stops'>,
  leg: 'out' | 'return',
  anchorSlot: number,
  stopMinutes: number,
): StopEta[] {
  const route = legRoute(lookup, request, leg);
  if (route.length <= 2) return [];
  if (leg === 'out') {
    let cumulative = 0;
    const etas: StopEta[] = [];
    for (let i = 1; i < route.length - 1; i++) {
      cumulative += hopMinutes(lookup, route[i - 1] as RouteStop, route[i] as RouteStop);
      etas.push({ locationId: route[i]?.locationId, slot: anchorSlot + Math.round(cumulative / 15) });
      cumulative += stopMinutes;
    }
    return etas;
  }
  let cumulative = 0;
  const etas: StopEta[] = [];
  for (let i = route.length - 1; i >= 1; i--) {
    cumulative += hopMinutes(lookup, route[i - 1] as RouteStop, route[i] as RouteStop);
    if (i - 1 >= 1) {
      etas.unshift({ locationId: route[i - 1]?.locationId, slot: anchorSlot - Math.round(cumulative / 15) });
      cumulative += stopMinutes;
    }
  }
  return etas;
}

/**
 * ETA (in slots) at ANY node of a leg's route, including the origin/
 * destination endpoints (unlike `stopEtas`, which only ever returns the
 * stops in between) — used by merge joining (`merge.ts`) to check a guest's
 * declared flexibility against the host's ETA at the guest's boarding place.
 * `undefined` when `locationId` is not on the route (including every
 * free-text stop, which never matches — ORIGINS_PLAN §6.3).
 */
export function routeEtaAt(
  lookup: TravelLookup,
  request: Pick<Request, 'originId' | 'destinationId' | 'stops'>,
  leg: 'out' | 'return',
  anchorSlot: number,
  stopMinutes: number,
  locationId: string,
): number | undefined {
  const route = legRoute(lookup, request, leg);
  const idx = route.findIndex((r) => r.locationId === locationId);
  if (idx === -1) return undefined;
  const last = route.length - 1;
  if ((leg === 'out' && idx === 0) || (leg === 'return' && idx === last)) return anchorSlot;
  const endIndex = leg === 'out' ? last : 0;
  if (idx === endIndex) {
    const totalMinutes = legRouteMinutes(lookup, request, leg, stopMinutes);
    return leg === 'out' ? anchorSlot + Math.round(totalMinutes / 15) : anchorSlot - Math.round(totalMinutes / 15);
  }
  const etas = stopEtas(lookup, request, leg, anchorSlot, stopMinutes);
  return etas[idx - 1]?.slot;
}
