import { parseFlexInterval } from "@/features/solverBridge/buildSolverInput";
import { withinFlex } from "./geometry";
import type { WeekRequestRow } from "../api";

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
export function requestWithinFlex(req: WeekRequestRow, startsAt: string, endsAt: string): boolean {
  const originalStart = requestStart(req);
  if (!originalStart) return false;
  const returning = req.trip_shape === "one_way_from";
  const startShift = (Date.parse(returning ? endsAt : startsAt) - Date.parse(originalStart)) / 60_000;
  if (!withinFlex(startShift,
    parseFlexInterval(returning ? req.flex_return_early : req.flex_depart_early),
    parseFlexInterval(returning ? req.flex_return_late : req.flex_depart_late))) return false;
  if (req.trip_shape !== "round_trip") return true;
  return !!req.return_at && withinFlex((Date.parse(endsAt) - Date.parse(req.return_at)) / 60_000,
    parseFlexInterval(req.flex_return_early), parseFlexInterval(req.flex_return_late));
}

/** The vehicle reservation also covers the volunteer's empty return/repositioning
 * leg; the passenger's requested arrival/departure stays the same anchor.
 */
export function standaloneChauffeurWindow(request: WeekRequestRow, dwellMinutes: number): { startsAt: string; endsAt: string } | null {
  if (request.trip_shape === "round_trip") return requestWindow(request);
  const anchor = requestStart(request);
  if (!anchor) return null;
  const duration = Math.max(15, Math.ceil((2 * Math.max(0, request.destination_travel_minutes ?? 30) + Math.max(0, dwellMinutes)) / 15) * 15) * 60_000;
  return request.trip_shape === "one_way_from"
    ? { startsAt: new Date(Math.floor((Date.parse(anchor) - duration) / (15 * 60_000)) * 15 * 60_000).toISOString(), endsAt: anchor }
    : { startsAt: anchor, endsAt: new Date(Date.parse(anchor) + duration).toISOString() };
}
