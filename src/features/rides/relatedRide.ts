// REQ §13.127 (b): who is "related" to a ride on the client (mirrors the server's `ride_related()`; RLS and the
// RPCs decide for real). Pure — no React, no Supabase.
import { namedPassengersOf, servedOf } from "./servedOf";

import type { BoardRide } from "./api";

export interface RelatedRideInput {
  ride: BoardRide;
  profileId: string | undefined;
  /** The ids of the requests the member may act on (own + filed by the member — `useMyRequests`). */
  myRequestIds: ReadonlySet<string>;
  /** `cars.owner_id` of the ride's car when it is a private (temporary) car, else null/undefined. */
  carOwnerId?: string | null;
}

/** Driver, a served request of mine (requested or filed), a named passenger, or the private car's owner. */
export function isRideRelated({ ride, profileId, myRequestIds, carOwnerId }: RelatedRideInput): boolean {
  if (!profileId) return false;
  return ride.driver_id === profileId
    || (!!carOwnerId && carOwnerId === profileId)
    || servedOf(ride).some((entry) => !!entry.request_id && myRequestIds.has(entry.request_id))
    || namedPassengersOf(ride).some((entry) => entry.person_id === profileId);
}

/**
 * The request the ride sheet's edit button opens when none of the member's own requests matches the ride:
 * the driver's request first, else the first served request. The edit page gates with `can_edit_request()`.
 */
export function relatedRequestIdToEdit(ride: BoardRide): string | undefined {
  const served = servedOf(ride).filter((entry) => !!entry.request_id);
  return (served.find((entry) => entry.role === "driver") ?? served[0])?.request_id ?? undefined;
}

/** REQ §13.169 (a): every request a ride serves, for the ride sheet's edit entries — the driver's first. */
export function rideEditTargets(ride: BoardRide): { requestId: string; requester: string }[] {
  const seen = new Set<string>();
  const targets: { requestId: string; requester: string; drives: boolean }[] = [];
  for (const entry of servedOf(ride)) {
    if (!entry.request_id || seen.has(entry.request_id)) continue;
    seen.add(entry.request_id);
    targets.push({ requestId: entry.request_id, requester: entry.requester ?? "", drives: entry.role === "driver" });
  }
  return targets
    .sort((a, b) => Number(b.drives) - Number(a.drives))
    .map(({ requestId, requester }) => ({ requestId, requester }));
}

/**
 * Whether the ride's requests let a member move it (the server's `edit_ride` member branch is the same rule): the
 * driver's own trip keeping the car, or their own one-way (הלוך בלבד — never a הקפצה relay leg), and — REQ §13.179 (a) —
 * anyone riding along on it (a merge), who never stops the people on the ride from moving it.
 */
export function rideMovableByMember(ride: BoardRide): boolean {
  return servedOf(ride).every((entry) => (entry.role === "driver"
      && (entry.car_mode === "keep" || (entry.car_mode === "relay" && entry.trip_type === "one_way")))
    || (entry.role === "passenger" && entry.car_mode === "passenger"));
}

/** REQ §13.179 (a): a ride serving more than one request is one shared ride (a merge) — its edit opens the main trip. */
export function isMergedRide(ride: BoardRide): boolean {
  return new Set(servedOf(ride).flatMap((entry) => entry.request_id ? [entry.request_id] : [])).size > 1;
}
