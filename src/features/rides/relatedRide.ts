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
