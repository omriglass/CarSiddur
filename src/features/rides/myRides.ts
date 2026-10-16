// "Which rides are on my /my screen" — pure selection rules (owner 2026-10-16, REQ §13.128).
// One rule for the list (`fetchMyUpcomingRides`) and the week view (`isMyBoardRide`): I am anywhere in the
// ride's people list (driver, requester, companion, named/added passenger) or one of my requests is served by it.
// The optional "children's rides" display adds rides of my children and of their other guardians — read-only.
import { namedPassengersOf, servedOf } from "./servedOf";
import { peopleOf } from "./ridePeople";
import type { BoardRide } from "@/features/siddur/api";

type RideShape = BoardRide;

/** True when `personId` (a profile id) appears anywhere in the ride's `people` list. */
export function personOnRide(ride: Pick<BoardRide, "people">, personId: string): boolean {
  return peopleOf(ride).some((person) => person.person_id === personId);
}

/**
 * A draft ride (unpublished day, visible to the managing Sadran/admin by RLS) is mine only when I drive it or am
 * named on it (a reservation) — a draft placement of one of my requests is a planning outcome that members never see
 * before publication (REQ §13.109 a), and the Sadran's own requests follow the same rule.
 */
export function isMyDraftRide(ride: RideShape, profileId: string | undefined): boolean {
  if (!profileId) return false;
  return ride.driver_id === profileId || namedPassengersOf(ride).some((entry) => entry.person_id === profileId);
}

export function isRideOfMine(ride: RideShape, profileId: string | undefined, myRequestIds: ReadonlySet<string>): boolean {
  if (!profileId) return false;
  if (ride.status === "draft") return isMyDraftRide(ride, profileId);
  return ride.driver_id === profileId
    || servedOf(ride).some((entry) => !!entry.request_id && myRequestIds.has(entry.request_id))
    || namedPassengersOf(ride).some((entry) => entry.person_id === profileId)
    || personOnRide(ride, profileId);
}

export interface RelatedRideLabel {
  kind: "child" | "guardian";
  /** The child's / the other guardian's display name. */
  name: string;
}

export interface RelatedRideScope {
  profileId: string | undefined;
  /** `child_guardians` rows of mine. */
  childIds: ReadonlySet<string>;
  /** Other guardians of my children (profile ids; never mine). */
  guardianIds: ReadonlySet<string>;
}

/**
 * Why a ride that is not mine still concerns my family: a child of mine is on it (`people` child row, which also
 * covers a request's `request_children`) or another guardian of one of my children is on it. Published rides only.
 * Empty = not related.
 */
export function relatedRideLabels(ride: RideShape, scope: RelatedRideScope): RelatedRideLabel[] {
  if (ride.status === "cancelled" || ride.status === "draft") return [];
  const labels: RelatedRideLabel[] = [];
  const seen = new Set<string>();
  for (const person of peopleOf(ride)) {
    const name = person.display_name.trim();
    if (person.child_id && scope.childIds.has(person.child_id)) {
      if (!seen.has(`c:${person.child_id}`)) { seen.add(`c:${person.child_id}`); labels.push({ kind: "child", name }); }
    } else if (person.person_id && person.person_id !== scope.profileId && scope.guardianIds.has(person.person_id)) {
      if (!seen.has(`g:${person.person_id}`)) { seen.add(`g:${person.person_id}`); labels.push({ kind: "guardian", name }); }
    }
  }
  return labels;
}

/** Rides of the family that are not mine, each with its labels; mine are never repeated here. */
export function selectRelatedRides<R extends RideShape & { id: string | null }>(
  rides: readonly R[],
  scope: RelatedRideScope,
  myRequestIds: ReadonlySet<string>,
): Map<string, RelatedRideLabel[]> {
  const out = new Map<string, RelatedRideLabel[]>();
  for (const ride of rides) {
    if (!ride.id || isRideOfMine(ride, scope.profileId, myRequestIds)) continue;
    const labels = relatedRideLabels(ride, scope);
    if (labels.length) out.set(ride.id, labels);
  }
  return out;
}
