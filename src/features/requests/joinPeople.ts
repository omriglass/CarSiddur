// DP1-1 (production 26.11): "אין רכב, לצרף לנסיעה של…" after a waitlisted save joins the ride with the
// request's own riders — never with whoever pressed the button. The Sadran (or a filer, or an anyone-edits
// member) editing someone else's request used to join the ride themselves.

import { buildAddPassengerInputs, type PickedMember } from "@/features/rides/addPassengers";

import type { RidePassengerInput } from "@/features/rides/api";
import type { ChildOption } from "./api";

export interface JoinPeopleArgs {
  /** The request's requester before this save: me for a new ride, the request's requester when editing. */
  requester: PickedMember | null;
  /** "אני" / the requester chip is on (false = the requester rides no more; the ride moved to a companion). */
  requesterRides: boolean;
  /** Named members riding besides the requester (on a new ride filed for someone else they include that person). */
  companionIds: readonly string[];
  childIds: readonly string[];
  guestNames: string;
  members: readonly PickedMember[];
  children: readonly ChildOption[];
}

/** The `add_ride_passengers()` list for joining a ride with this request's people, each person once. */
export function joinPeopleInputs(args: JoinPeopleArgs): RidePassengerInput[] {
  const requesterId = args.requesterRides ? args.requester?.id ?? null : null;
  const companionIds = [...new Set(args.companionIds)].filter((id) => id !== requesterId);
  return [
    ...(requesterId ? [{ person_id: requesterId, display_name: args.requester?.name ?? "", seat_kind: "adult" as const }] : []),
    ...buildAddPassengerInputs(companionIds, args.childIds, args.guestNames, args.members, args.children),
  ];
}
