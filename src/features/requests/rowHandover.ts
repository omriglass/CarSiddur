import { carHandoverNotes, combineSeriesNeighbours, type CarHandoverNotes, type CarNeighbours } from "@/features/rides/carHandover";

import type { MyRequestRide } from "./api";
import type { DisplayRow } from "./myRequestsRows";

/**
 * "Be back on time" for a /my row (REQ §13.108 f). The rows here are always the signed-in member's own requests,
 * so the viewer is a requester of the ride. A multi-day row takes "next" from its LAST leg's ride and "prev" from
 * its FIRST leg's.
 */
function activeRide(ride: MyRequestRide | null | undefined): MyRequestRide | null {
  return ride && ride.status !== "cancelled" ? ride : null;
}

function legRides(row: DisplayRow): { first: MyRequestRide | null; last: MyRequestRide | null } {
  const rides = (row.seriesLegs ?? [row]).map((leg) => activeRide(leg.ride)).filter((ride): ride is MyRequestRide => !!ride);
  return { first: rides[0] ?? null, last: rides[rides.length - 1] ?? null };
}

/** Ride ids whose neighbours a set of rows needs (first + last leg ride of each row). */
export function rowHandoverRideIds(rows: readonly DisplayRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const { first, last } = legRides(row);
    if (first) ids.add(first.id);
    if (last) ids.add(last.id);
  }
  return [...ids];
}

export function rowHandover(
  row: DisplayRow,
  neighboursByRide: ReadonlyMap<string, CarNeighbours> | undefined,
  viewerId: string | null | undefined,
): { notes: CarHandoverNotes; span: { startsAt: string; endsAt: string } } | null {
  if (!neighboursByRide || !viewerId) return null;
  const { first, last } = legRides(row);
  if (!first || !last) return null;
  const neighbours = combineSeriesNeighbours(neighboursByRide.get(first.id), neighboursByRide.get(last.id));
  const notes = carHandoverNotes(neighbours, viewerId, [viewerId]);
  if (!notes.returnBy && !notes.arrivesFrom) return null;
  return { notes, span: { startsAt: first.startsAt, endsAt: last.endsAt } };
}
