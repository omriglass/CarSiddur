// REQ §13.94 (docs/BOARD_DRAFTS_PLAN_2026-10.md §2): the route of a ride, TS twin of SQL
// `_ride_route` / `_route_add_place`. The board uses it to draw a *pending* (draft/sent) merge as
// the ride it would become: the host ride's current route plus the guest's boarding and alighting
// places inserted where they add the least driving, ETAs along the way, and the end extended only
// by the added driving. Same algorithm as SQL (cheapest insertion over place travel, boarding
// before alighting, a place already on the route is not duplicated, `stop_minutes` dwell at every
// intermediate stop, out leg forward from the start, return leg backward from the end). Pure: no
// React, no Supabase, no wall-clock.
import { fromZonedTime } from "date-fns-tz";

import { TZ, dateKey } from "./time";

export type RouteKind = "origin" | "stop" | "board" | "alight" | "destination";
export type RouteLeg = "out" | "return";

export interface RoutePoint {
  leg: RouteLeg;
  position: number;
  placeId: string | null;
  placeText: string | null;
  name: string;
  requestId: string | null;
  kind: RouteKind;
  /** ISO instant; `null` only on a hand-built point that was never timed. */
  eta: string | null;
}

/** Minutes of driving between two places (`null` place = free text / unknown -> default hop). */
export type Hop = (fromId: string | null, toId: string | null) => number;

/** Unknown travel between two places (REQ item 14; SQL `_route_hop_minutes`): 60 minutes. Not the 30-minute turnaround default. */
export const DEFAULT_HOP_MINUTES = 60;
export const DEFAULT_STOP_MINUTES = 5;

const KINDS: readonly RouteKind[] = ["origin", "stop", "board", "alight", "destination"];

/** Reads `v_board_rides.route` (jsonb array) into ordered points (leg out first, then by position). */
export function parseRideRoute(raw: unknown): RoutePoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((item): RoutePoint[] => {
      if (!item || typeof item !== "object") return [];
      const o = item as Record<string, unknown>;
      if (o.leg !== "out" && o.leg !== "return") return [];
      const kind = KINDS.find((k) => k === o.kind);
      if (!kind) return [];
      const placeText = typeof o.place_text === "string" && o.place_text ? o.place_text : null;
      return [{
        leg: o.leg,
        position: typeof o.position === "number" ? o.position : 0,
        placeId: typeof o.place_id === "string" ? o.place_id : null,
        placeText,
        name: typeof o.name === "string" && o.name ? o.name : (placeText ?? ""),
        requestId: typeof o.request_id === "string" ? o.request_id : null,
        kind,
        eta: typeof o.eta === "string" ? o.eta : null,
      }];
    })
    .sort((a, b) => (a.leg === b.leg ? a.position - b.position : a.leg === "out" ? -1 : 1));
}

/**
 * The places a ride passes through between its start and its destination, per leg, in route order
 * (stops, boarding and alighting points; consecutive repeats collapsed) — the board/siddur card's
 * "דרך: …" line (owner 2026-10-05: show the stops, not a count).
 */
export function routeViaNames(points: readonly Pick<RoutePoint, "leg" | "kind" | "name">[]): { out: string[]; return: string[] } {
  const via = { out: [] as string[], return: [] as string[] };
  for (const point of points) {
    if (point.kind === "origin" || point.kind === "destination" || !point.name) continue;
    const list = via[point.leg];
    if (list[list.length - 1] !== point.name) list.push(point.name);
  }
  return via;
}

/** `true` when a route has anything between the first and last place of a leg (stops, boarding, alighting). */
export function routeHasIntermediates(points: readonly Pick<RoutePoint, "kind">[]): boolean {
  return points.some((p) => p.kind === "stop" || p.kind === "board" || p.kind === "alight");
}

/** A hop function over the board's `place_travel_for_week` rows (symmetric; unknown pairs -> `fallback`). */
export function makeHop(
  travel: readonly { fromId: string; toId: string; travelMinutes?: number }[],
  fallback: number = DEFAULT_HOP_MINUTES,
): Hop {
  const byPair = new Map<string, number>();
  for (const edge of travel) {
    if (edge.travelMinutes == null) continue;
    byPair.set(`${edge.fromId}|${edge.toId}`, edge.travelMinutes);
    if (!byPair.has(`${edge.toId}|${edge.fromId}`)) byPair.set(`${edge.toId}|${edge.fromId}`, edge.travelMinutes);
  }
  return (fromId, toId) => {
    if (!fromId || !toId) return fallback;
    if (fromId === toId) return 0;
    return Math.max(byPair.get(`${fromId}|${toId}`) ?? fallback, 0);
  };
}

/**
 * The home <-> place edges `place_travel_for_week` leaves out (it only returns pairs beyond the
 * `destinations` preset): home to every preset place with its stored `travel_minutes`. Append
 * these to the week's rows before `makeHop` so a home-origin ride is not priced at the 60 min fallback.
 */
export function homeTravelEdges(
  homeId: string | null | undefined,
  destinations: readonly { id: string; travel_minutes: number | null; distance_km?: number | null }[],
): { fromId: string; toId: string; travelMinutes: number; distanceKm?: number }[] {
  if (!homeId) return [];
  return destinations.flatMap((d) => (d.id !== homeId && d.travel_minutes != null
    ? [{ fromId: homeId, toId: d.id, travelMinutes: d.travel_minutes, ...(d.distance_km != null ? { distanceKm: d.distance_km } : {}) }] : []));
}

/** Kilometres between two places (`null` = unknown: free text, or no stored distance). */
export type HopKm = (fromId: string | null, toId: string | null) => number | null;

/** Symmetric km lookup over the same rows as `makeHop` (rows without `distanceKm` are unknown). */
export function makeHopKm(travel: readonly { fromId: string; toId: string; distanceKm?: number }[]): HopKm {
  const byPair = new Map<string, number>();
  for (const edge of travel) {
    if (edge.distanceKm == null) continue;
    byPair.set(`${edge.fromId}|${edge.toId}`, edge.distanceKm);
    if (!byPair.has(`${edge.toId}|${edge.fromId}`)) byPair.set(`${edge.toId}|${edge.fromId}`, edge.distanceKm);
  }
  return (fromId, toId) => {
    if (!fromId || !toId) return null;
    if (fromId === toId) return 0;
    return byPair.get(`${fromId}|${toId}`) ?? null;
  };
}

export interface RoutePassenger {
  requestId: string;
  name?: string | null;
  originId: string | null;
  originText?: string | null;
  originName?: string | null;
  destinationId: string | null;
  destinationText?: string | null;
  destinationName?: string | null;
  /** The legs the passenger joins (`out` / `return` / `both`). */
  leg: "out" | "return" | "both";
}

type Draft = Omit<RoutePoint, "position" | "eta">;

/** Mirror of SQL `_route_add_place`: `after` is the 1-based index the place must come after (0 = anywhere after the origin). */
function addPlace(route: Draft[], place: Draft, after: number, hop: Hop, dedupeMax: number, insertMax: number): { index: number; route: Draft[] } | null {
  const n = route.length;
  if (place.placeId) {
    for (let i = Math.max(after, 0) + 1; i <= Math.min(n, dedupeMax); i++) {
      if (route[i - 1]!.placeId === place.placeId) return { index: i, route };
    }
  }
  let bestK = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let k = Math.max(after + 1, 2); k <= Math.min(n + 1, insertMax); k++) {
    const prev = route[k - 2]?.placeId ?? null;
    let cost: number;
    if (k <= n) {
      const next = route[k - 1]?.placeId ?? null;
      cost = hop(prev, place.placeId) + hop(place.placeId, next) - hop(prev, next);
    } else {
      cost = hop(prev, place.placeId);
    }
    if (cost < bestCost) { bestCost = cost; bestK = k; }
  }
  if (bestK < 0) return null;
  const next = [...route];
  next.splice(bestK - 1, 0, place);
  return { index: bestK, route: next };
}

/** Out leg forward from `startMs`, return leg backward from `endMs`; `stopMinutes` dwell at every intermediate stop. */
export function routeEtas(points: readonly Draft[], leg: RouteLeg, startMs: number, endMs: number, hop: Hop, stopMinutes: number): RoutePoint[] {
  const n = points.length;
  const out: RoutePoint[] = [];
  if (leg === "out") {
    let t = startMs;
    points.forEach((p, i0) => {
      const i = i0 + 1;
      if (i > 1) t += ((i > 2 ? stopMinutes : 0) + hop(points[i0 - 1]!.placeId, p.placeId)) * 60_000;
      out.push({ ...p, position: i0, eta: new Date(t).toISOString() });
    });
    return out;
  }
  let t = endMs;
  for (let i = n; i >= 1; i--) {
    const p = points[i - 1]!;
    if (i < n) t -= ((i + 1 < n ? stopMinutes : 0) + hop(p.placeId, points[i]!.placeId)) * 60_000;
    out.unshift({ ...p, position: i - 1, eta: new Date(t).toISOString() });
  }
  return out;
}

/** Driving + dwell minutes of one leg (`first eta` -> `last eta`). */
export function legMinutes(points: readonly Pick<RoutePoint, "placeId">[], hop: Hop, stopMinutes: number): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += hop(points[i - 1]!.placeId, points[i]!.placeId) + (i > 1 ? stopMinutes : 0);
  }
  return total;
}

const strip = (p: RoutePoint): Draft => ({ leg: p.leg, placeId: p.placeId, placeText: p.placeText, name: p.name, requestId: p.requestId, kind: p.kind });

/** Quarter-hour ceiling of `endMs`, capped at 23:59 of the start's day (SQL `_round_up_ride_end`). */
export function roundUpRideEnd(startMs: number, endMs: number): number {
  const rounded = Math.ceil(endMs / 900_000) * 900_000;
  const day = dateKey(new Date(startMs));
  return dateKey(new Date(rounded)) !== day ? fromZonedTime(`${day}T23:59:00`, TZ).getTime() : rounded;
}

export interface MergedRoute {
  route: RoutePoint[];
  startsAt: string;
  endsAt: string;
  addedMinutes: number;
  /** ETA at the passenger's boarding point (first leg they join), or `null` when no leg of the host covers them. */
  boardEta: string | null;
  boardLeg: RouteLeg | null;
  /** REQ §13.95 (H1): `false` when the merge is not allowed - see `invalid`. The route is then the host's own. */
  valid: boolean;
  invalid: MergeInvalid | null;
  /** The host's own start (before the merge); `startsAt` is earlier by the added out-leg driving. */
  originalStartsAt: string;
  /** Added driving per leg (minutes). */
  addedOutMinutes: number;
  addedReturnMinutes: number;
}

/**
 * REQ item 108 D3: the detour limits SQL `_merge_check` applies when `department_settings` leaves
 * them null (`coalesce(detour_limit_minutes, 20)` / `coalesce(detour_limit_km, 15)`). The twin never
 * skips the check for a missing limit.
 */
export const DEFAULT_DETOUR_LIMIT_MINUTES = 20;
export const DEFAULT_DETOUR_LIMIT_KM = 15;

/** Why a merge is refused: boards at/after the base's final destination, or the detour is over the limit. */
export type MergeInvalid = "boards_at_end" | "detour_too_long";

/** Quarter-hour floor (the start moves earlier, never later). */
export function roundDownRideStart(startMs: number): number {
  return Math.floor(startMs / 900_000) * 900_000;
}

/** Kilometres of a leg (`null` when any hop is unknown). */
function legKm(points: readonly Pick<RoutePoint, "placeId">[], hopKm: HopKm): number | null {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const km = hopKm(points[i - 1]!.placeId, points[i]!.placeId);
    if (km == null) return null;
    total += km;
  }
  return total;
}

/**
 * The host ride after `passenger` joins (REQ §13.95 H1; SQL `ride_route()` twin): on every leg
 * they join that the host route has, boarding is inserted strictly BEFORE the leg's final place
 * and alighting at or before it (cheapest insertion), and the added driving on the leg must stay
 * within `detourLimitMinutes` / `detourLimitKm` - otherwise `valid` is false and the host's own
 * route comes back. The ride then LEAVES earlier by the added out-leg driving (rounded down to a
 * quarter hour) and ENDS later by the added return-leg driving (rounded up, capped 23:59, never
 * shortened), so the base person's own times are kept.
 */
export function mergePassengerIntoRoute(input: {
  route: readonly RoutePoint[];
  startsAt: string;
  endsAt: string;
  passenger: RoutePassenger;
  hop: Hop;
  stopMinutes?: number;
  detourLimitMinutes?: number | null;
  detourLimitKm?: number | null;
  hopKm?: HopKm;
}): MergedRoute {
  const { passenger, hop } = input;
  const stopMinutes = input.stopMinutes ?? DEFAULT_STOP_MINUTES;
  const detourLimitMinutes = input.detourLimitMinutes ?? DEFAULT_DETOUR_LIMIT_MINUTES;
  const detourLimitKm = input.detourLimitKm ?? DEFAULT_DETOUR_LIMIT_KM;
  const startMs = Date.parse(input.startsAt);
  const endMs = Date.parse(input.endsAt);
  const legsOf = (leg: RouteLeg) => input.route.filter((p) => p.leg === leg).sort((a, b) => a.position - b.position);
  const original: Record<RouteLeg, Draft[]> = { out: legsOf("out").map(strip), return: legsOf("return").map(strip) };
  const grown: Record<RouteLeg, Draft[]> = { out: original.out, return: original.return };
  const addedBy: Record<RouteLeg, number> = { out: 0, return: 0 };
  let invalid: MergeInvalid | null = null;
  let boardLeg: RouteLeg | null = null;
  let boardIndex = -1;
  for (const leg of ["out", "return"] as const) {
    const joins = passenger.leg === "both" || passenger.leg === leg;
    if (!joins || grown[leg].length < 2) continue;
    const base = grown[leg];
    const n = base.length;
    const before = legMinutes(base, hop, stopMinutes);
    const boardsAtOrigin = leg === "out";
    const board: Draft = {
      leg, kind: "board", requestId: passenger.requestId,
      placeId: boardsAtOrigin ? passenger.originId : passenger.destinationId,
      placeText: (boardsAtOrigin ? passenger.originText : passenger.destinationText) ?? null,
      name: (boardsAtOrigin ? passenger.originName : passenger.destinationName) ?? (boardsAtOrigin ? passenger.originText : passenger.destinationText) ?? "",
    };
    const alight: Draft = {
      leg, kind: "alight", requestId: passenger.requestId,
      placeId: boardsAtOrigin ? passenger.destinationId : passenger.originId,
      placeText: (boardsAtOrigin ? passenger.destinationText : passenger.originText) ?? null,
      name: (boardsAtOrigin ? passenger.destinationName : passenger.originName) ?? (boardsAtOrigin ? passenger.destinationText : passenger.originText) ?? "",
    };
    // Boards strictly before the leg's final place (dedupe up to n-1, insert before the last point),
    // alights at or before it.
    if (board.placeId && board.placeId === base[n - 1]!.placeId) { invalid = "boards_at_end"; break; }
    const first = addPlace(base, board, 0, hop, n - 1, n);
    const second = first ? addPlace(first.route, alight, first.index, hop, first.route.length, first.route.length) : null;
    if (!first || !second) { invalid = "boards_at_end"; break; }
    grown[leg] = second.route;
    // REQ §13.95, same rule as SQL `_merge_check`: a free-text place on the merged leg has no known
    // travel time, so the added driving is unknown — no detour-limit refusal and no automatic
    // window change (the Sadran decides). List places keep the limit.
    if (second.route.some((p) => !p.placeId)) {
      if (boardLeg === null) { boardLeg = leg; boardIndex = first.index - 1; }
      continue;
    }
    addedBy[leg] = Math.max(legMinutes(second.route, hop, stopMinutes) - before, 0);
    if (addedBy[leg] > detourLimitMinutes) { invalid = "detour_too_long"; break; }
    if (input.hopKm) {
      const kmBefore = legKm(base, input.hopKm);
      const kmAfter = legKm(second.route, input.hopKm);
      if (kmBefore != null && kmAfter != null && kmAfter - kmBefore > detourLimitKm) { invalid = "detour_too_long"; break; }
    }
    if (boardLeg === null) { boardLeg = leg; boardIndex = first.index - 1; }
  }
  if (invalid) {
    const route = [
      ...(original.out.length ? routeEtas(original.out, "out", startMs, endMs, hop, stopMinutes) : []),
      ...(original.return.length ? routeEtas(original.return, "return", startMs, endMs, hop, stopMinutes) : []),
    ];
    return {
      route, startsAt: input.startsAt, endsAt: input.endsAt, addedMinutes: 0, boardEta: null, boardLeg: null,
      valid: false, invalid, originalStartsAt: input.startsAt, addedOutMinutes: 0, addedReturnMinutes: 0,
    };
  }
  const added = addedBy.out + addedBy.return;
  const newStartMs = addedBy.out > 0 ? Math.min(startMs, roundDownRideStart(startMs - addedBy.out * 60_000)) : startMs;
  const newEndMs = addedBy.return > 0 ? Math.max(endMs, roundUpRideEnd(startMs, endMs + addedBy.return * 60_000)) : endMs;
  const route = [
    ...(grown.out.length ? routeEtas(grown.out, "out", newStartMs, newEndMs, hop, stopMinutes) : []),
    ...(grown.return.length ? routeEtas(grown.return, "return", newStartMs, newEndMs, hop, stopMinutes) : []),
  ];
  // The boarding place may coincide with a place already on the route (e.g. the host's own origin),
  // in which case no separate "board" point exists - the ETA is then that place's.
  const boardPoint = boardLeg ? route.find((p) => p.leg === boardLeg && p.position === boardIndex) : undefined;
  return {
    route,
    startsAt: new Date(newStartMs).toISOString(),
    endsAt: new Date(newEndMs).toISOString(),
    addedMinutes: added,
    boardEta: boardPoint?.eta ?? null,
    boardLeg,
    valid: true,
    invalid: null,
    originalStartsAt: input.startsAt,
    addedOutMinutes: addedBy.out,
    addedReturnMinutes: addedBy.return,
  };
}

/** A route for a ride that has none stored (reservation / legacy row): origin -> destination of the ride itself. */
export function fallbackRoute(ride: {
  startsAt: string; endsAt: string;
  originId: string | null; originName?: string | null;
  destinationId: string | null; destinationName?: string | null;
}): RoutePoint[] {
  return [
    { leg: "out", position: 0, placeId: ride.originId, placeText: null, name: ride.originName ?? "", requestId: null, kind: "origin", eta: ride.startsAt },
    { leg: "out", position: 1, placeId: ride.destinationId, placeText: null, name: ride.destinationName ?? "", requestId: null, kind: "destination", eta: ride.endsAt },
  ];
}
