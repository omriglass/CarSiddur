// QA run 22 R22B9 / R22U3 (owner 2026-11-22): a merge asks "דיברת עם X?" about, and makes consenting parties of, only
// the people whose own part of the host ride changes - the driver (it is their car and route) and the requesters of
// the trips whose times move. A rider whose stops keep their times is not asked (they still hear that someone joined).
import type { RoutePoint } from "@/lib/rideRoute";

export interface AffectedTrip {
  requestId: string;
  /** The legs of the host ride this trip rides. */
  leg: "out" | "return" | "both";
  /** Where the trip gets on / off (its own origin and destination); a trip with no own point rides from / to these. */
  originId: string | null;
  destinationId: string | null;
}

const minute = (iso: string | null | undefined) => (iso ? Math.round(Date.parse(iso) / 60_000) : null);

const samePlace = (a: RoutePoint, b: RoutePoint) => a.leg === b.leg && a.kind === b.kind && a.requestId === b.requestId
  && a.placeId === b.placeId && a.placeText === b.placeText;

/** The point of `before` in the merged route (positions move when a stop is inserted). */
function after(point: RoutePoint, merged: readonly RoutePoint[]): RoutePoint | undefined {
  return merged.find((p) => samePlace(p, point));
}

function moved(point: RoutePoint | undefined, merged: readonly RoutePoint[]): boolean {
  if (!point) return false;
  const next = after(point, merged);
  return !next || minute(next.eta) !== minute(point.eta);
}

/**
 * The trips (request ids) of the host ride whose times the merge changes: an own stop of theirs at another time, or -
 * for a trip that boards / alights at the ride's own places - that place's time on the legs it rides (the ride's start
 * or end when the place is not on the route).
 */
export function mergeAffectedRequestIds(input: {
  before: readonly RoutePoint[];
  merged: readonly RoutePoint[];
  startsAt: string; newStartsAt: string;
  endsAt: string; newEndsAt: string;
  trips: readonly AffectedTrip[];
}): Set<string> {
  const affected = new Set<string>();
  const startMoved = minute(input.startsAt) !== minute(input.newStartsAt);
  const endMoved = minute(input.endsAt) !== minute(input.newEndsAt);
  for (const trip of input.trips) {
    const legs = trip.leg === "both" ? (["out", "return"] as const) : [trip.leg];
    let changed = false;
    for (const leg of legs) {
      const onLeg = input.before.filter((p) => p.leg === leg);
      const own = onLeg.filter((p) => p.requestId === trip.requestId);
      if (own.some((p) => moved(p, input.merged))) { changed = true; break; }
      // where they get on and off this leg: an own board / alight point, else the ride's point at their place
      const boardPlace = leg === "out" ? trip.originId : trip.destinationId;
      const alightPlace = leg === "out" ? trip.destinationId : trip.originId;
      const ownBoard = own.some((p) => p.kind === "board" || p.kind === "origin");
      const ownAlight = own.some((p) => p.kind === "alight" || p.kind === "destination");
      if (!ownBoard) {
        const at = onLeg.find((p) => p.placeId && p.placeId === boardPlace);
        if (at ? moved(at, input.merged) : leg === "out" && startMoved) { changed = true; break; }
      }
      if (!ownAlight) {
        const at = [...onLeg].reverse().find((p) => p.placeId && p.placeId === alightPlace);
        if (at ? moved(at, input.merged) : leg === "return" && endMoved) { changed = true; break; }
      }
    }
    if (changed) affected.add(trip.requestId);
  }
  return affected;
}
