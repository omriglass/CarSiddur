import { parseFlexInterval } from "@/features/solverBridge/buildSolverInput";
import { legMinutes, type Hop } from "@/lib/rideRoute";
import { withinFlex } from "./geometry";
import type { WeekRequestRow } from "../api";

export type RequestTripType = "round_trip" | "one_way" | "drop_off";

/**
 * The member-facing trip type (REQ §13.93). Rows always carry it; the fallback only keeps
 * legacy fixtures/old clients working, derived the way the solver's `effectiveTripType` does
 * (any one-way shape is a drop-off, a round trip stays a round trip).
 */
export function tripTypeOf(request: Pick<WeekRequestRow, "trip_shape"> & { trip_type?: RequestTripType | null }): RequestTripType {
  return request.trip_type ?? (request.trip_shape === "round_trip" ? "round_trip" : "drop_off");
}

/** Round trips and one-way trips are driven by the requester; only a drop-off (הקפצה) needs another driver. */
export function requesterDrives(request: Pick<WeekRequestRow, "trip_shape"> & { trip_type?: RequestTripType | null }): boolean {
  return tripTypeOf(request) !== "drop_off";
}

/** The day anchor is the requested arrival home for one-way-from requests. */
export function requestStart(request: Pick<WeekRequestRow, "trip_shape" | "depart_at" | "return_at">): string | null {
  return request.trip_shape === "one_way_from" ? request.return_at : request.depart_at;
}

export function requestWindow(request: WeekRequestRow): { startsAt: string; endsAt: string } | null {
  const anchor = requestStart(request);
  if (!anchor) return null;
  const travelMs = Math.max(15, Math.ceil((request.destination_travel_minutes ?? 30) / 15) * 15) * 60_000;
  if (request.trip_shape === "one_way_from") return { startsAt: new Date(Date.parse(anchor) - travelMs).toISOString(), endsAt: anchor };
  const endsAt = request.trip_shape === "round_trip" ? request.return_at : new Date(Date.parse(anchor) + travelMs).toISOString();
  return endsAt ? { startsAt: anchor, endsAt } : null;
}

/** Interval partitioning: one lane per simultaneous unmet request, reused after each interval ends. */
export function packPhantomLanes<T extends { id: string; startMinutes: number; endMinutes: number }>(items: readonly T[]): (T & { lane: number })[] {
  const ends: number[] = [];
  return [...items].sort((a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id)).map((item) => {
    let lane = ends.findIndex((end) => end <= item.startMinutes);
    if (lane < 0) lane = ends.length;
    ends[lane] = item.endMinutes;
    return { ...item, lane };
  });
}

/** Compare each edited endpoint with the request, never the previously moved ride. */
export function requestWithinFlex(req: WeekRequestRow, startsAt: string, endsAt: string, servedLeg?: "out" | "return" | "both" | null, chauffeur = false): boolean {
  const originalStart = requestStart(req);
  if (!originalStart) return false;
  // QB12 / R2B9: a pickup (return) leg of a drop-off is judged by its own time (the ride's start)
  // against the return flexibility. When the ride's served leg is known that decides; else the
  // closer of the two requested times does.
  const dropOffWithPickup = tripTypeOf(req) === "drop_off" && req.trip_shape === "round_trip" && !!req.return_at;
  const pickupLeg = dropOffWithPickup && (servedLeg === "return" ? true : servedLeg === "out" ? false
    : Math.abs(Date.parse(startsAt) - Date.parse(req.return_at as string)) < Math.abs(Date.parse(startsAt) - Date.parse(originalStart)));
  if (pickupLeg && req.return_at) {
    // A chauffeur pickup ride is placed so that it ENDS at the pickup time (`standaloneChauffeurWindow`),
    // so moving it is judged by the same end against the return flexibility (R2B9: one time, not two).
    return withinFlex((Date.parse(chauffeur ? endsAt : startsAt) - Date.parse(req.return_at)) / 60_000,
      parseFlexInterval(req.flex_return_early), parseFlexInterval(req.flex_return_late));
  }
  const returning = req.trip_shape === "one_way_from";
  const startShift = (Date.parse(returning ? endsAt : startsAt) - Date.parse(originalStart)) / 60_000;
  if (!withinFlex(startShift,
    parseFlexInterval(returning ? req.flex_return_early : req.flex_depart_early),
    parseFlexInterval(returning ? req.flex_return_late : req.flex_depart_late))) return false;
  // A drop-off with pickup places only its out leg at a time; the return is checked when it is placed.
  if (req.trip_shape !== "round_trip" || tripTypeOf(req) === "drop_off") return true;
  return !!req.return_at && withinFlex((Date.parse(endsAt) - Date.parse(req.return_at)) / 60_000,
    parseFlexInterval(req.flex_return_early), parseFlexInterval(req.flex_return_late));
}

/** The vehicle reservation also covers the volunteer's empty return/repositioning
 * leg; the passenger's requested arrival/departure stays the same anchor.
 */
export function standaloneChauffeurWindow(request: WeekRequestRow, dwellMinutes: number): { startsAt: string; endsAt: string } | null {
  // A round trip the requester drives keeps its whole span. A drop-off that is also picked up
  // (round-trip shape) places only its out leg as a chauffeur ride, like a one-way-to leg.
  if (request.trip_shape === "round_trip" && tripTypeOf(request) !== "drop_off") return requestWindow(request);
  const anchor = requestStart(request);
  if (!anchor) return null;
  const duration = Math.max(15, Math.ceil((2 * Math.max(0, request.destination_travel_minutes ?? 30) + Math.max(0, dwellMinutes)) / 15) * 15) * 60_000;
  return request.trip_shape === "one_way_from"
    ? { startsAt: new Date(Math.floor((Date.parse(anchor) - duration) / (15 * 60_000)) * 15 * 60_000).toISOString(), endsAt: anchor }
    : { startsAt: anchor, endsAt: new Date(Date.parse(anchor) + duration).toISOString() };
}

/**
 * REQ §13.94 (item 7): the minutes of a one-way request's route **from its own origin** (stops
 * included, `stop_minutes` dwell at every intermediate stop) - what the placement window must
 * use instead of the home-based `destination_travel_minutes`. A return-shaped request uses its
 * return stops. `null` when the request has no destination place to measure to.
 */
export function routeTravelMinutes(
  request: Pick<WeekRequestRow, "trip_shape" | "origin_id" | "origin_text" | "destination_id" | "stops">,
  ctx: { hop: Hop; stopMinutes: number; homeId?: string | null },
): number | null {
  if (!request.destination_id && !request.stops?.length) return null;
  const leg = request.trip_shape === "one_way_from" ? "return" : "out";
  const origin = request.origin_id ?? (request.origin_text ? null : ctx.homeId ?? null);
  const stops = (request.stops ?? []).filter((stop) => stop.leg === leg).sort((a, b) => a.position - b.position).map((stop) => stop.place_id);
  const places = leg === "out" ? [origin, ...stops, request.destination_id] : [request.destination_id, ...stops, origin];
  if (places.length < 2) return null;
  return legMinutes(places.map((placeId) => ({ placeId })), ctx.hop, ctx.stopMinutes);
}

/**
 * Board copies of the requests whose `destination_travel_minutes` is the origin-based route
 * minutes (`routeTravelMinutes`), so every placement window (`requestWindow`,
 * `standaloneChauffeurWindow`, phantom lanes, drop previews) uses the real route. The solver and
 * the proposal payloads keep reading the untouched rows.
 */
export function withRouteTravelMinutes<T extends WeekRequestRow>(requests: readonly T[], ctx: { hop: Hop; stopMinutes: number; homeId?: string | null }): T[] {
  return requests.map((request) => {
    const minutes = routeTravelMinutes(request, ctx);
    return minutes == null ? request : { ...request, destination_travel_minutes: minutes };
  });
}
