// PS1 (owner 2026-11-22): someone added to a ride with "+ נוסעים" who answered "no, just add them" keeps their own
// request waiting. The waiting card says "כבר בנסיעה של Y", auto-fill leaves the request alone, and placing it by hand
// asks first (the shared "already on a ride at these hours" question). This finds those requests: an unplaced one
// whose requester is a plain "+ נוסעים" row (`source: 'added'`) on a ride overlapping the request's own hours.
// Pure, unit-tested (`ridingAsAdded.test.ts`).
import { peopleOf } from "./ridePeople";

import type { BoardRide } from "./api";

export interface RidingAsAdded {
  rideId: string;
  driverName: string | null;
  startsAt: string;
  endsAt: string;
}

const UNPLACED = new Set(["submitted", "waitlisted", "proposed"]);

type RequestLike = { id: string; requester_id: string | null; status: string; depart_at: string | null; return_at: string | null };
type RideLike = Pick<BoardRide, "id" | "status" | "starts_at" | "ends_at" | "driver_name" | "people">;

/** Request id -> the ride its requester already rides as an added passenger at the request's hours. */
export function requestsRidingAsAdded(requests: readonly RequestLike[], rides: readonly RideLike[]): Map<string, RidingAsAdded> {
  const byPerson = new Map<string, RidingAsAdded[]>();
  for (const ride of rides) {
    if (!ride.id || ride.status === "cancelled" || !ride.starts_at || !ride.ends_at) continue;
    for (const person of peopleOf(ride)) {
      if (person.source !== "added" || !person.person_id) continue;
      const list = byPerson.get(person.person_id) ?? [];
      list.push({ rideId: ride.id, driverName: ride.driver_name ?? null, startsAt: ride.starts_at, endsAt: ride.ends_at });
      byPerson.set(person.person_id, list);
    }
  }
  const found = new Map<string, RidingAsAdded>();
  for (const request of requests) {
    if (!request.requester_id || !UNPLACED.has(request.status)) continue;
    const start = request.depart_at ?? request.return_at;
    const end = request.return_at ?? request.depart_at;
    if (!start || !end) continue;
    const from = Date.parse(start);
    const to = Math.max(Date.parse(end), from + 60_000);
    const ride = (byPerson.get(request.requester_id) ?? []).find((candidate) => Date.parse(candidate.startsAt) < to && from < Date.parse(candidate.endsAt));
    if (ride) found.set(request.id, ride);
  }
  return found;
}
