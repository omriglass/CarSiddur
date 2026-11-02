// REQ §13.175 (d): a member drags their own ride onto someone's pickup / drop-off on the siddur (or stretches it over one
// on the same car) to take that person along. Pure helpers, unit tested; the server (`member_merge_preview` /
// `member_merge_ride`) decides.
import type { MemberMergePreview } from "./api";
import type { BoardRide } from "./api";
import type { MergeWaitChoice } from "./mergeQuestions";
import { peopleOf } from "./ridePeople";
import { isReservation, servedOf } from "./servedOf";

export interface MemberMergeTarget {
  ride: BoardRide;
  requestId: string;
  name: string;
}

/**
 * The ride a move runs into that carries someone else as a rider (not the driver of their own trip) — the person the
 * member may take along. Only when the move runs into exactly that one ride; anything else stays an ordinary collision.
 */
export function memberMergeTarget(conflicts: readonly BoardRide[], viewerId: string | undefined): MemberMergeTarget | null {
  if (conflicts.length !== 1 || !viewerId) return null;
  const ride = conflicts[0]!;
  if (!ride.id || ride.status === "cancelled" || isReservation(ride)) return null;
  const riders = new Set(servedOf(ride).filter((entry) => entry.role !== "driver" && entry.request_id).map((entry) => entry.request_id));
  const guest = peopleOf(ride).find((person) => person.source === "requester" && !!person.request_id && riders.has(person.request_id)
    && person.person_id !== viewerId);
  return guest?.request_id ? { ride, requestId: guest.request_id, name: guest.display_name } : null;
}

/** The ride would reach the guest at another time than asked, and stretching it would keep the guest's own time. */
export function memberMergeWaitChoice(preview: MemberMergePreview): MergeWaitChoice | null {
  if (!preview.waitKeepsTime) return null;
  if (preview.waitEndsAt && preview.joinerReturnAt && preview.wantedReturnAt) {
    return { side: "return", eta: preview.joinerReturnAt, wanted: preview.wantedReturnAt, startsAt: null, endsAt: preview.waitEndsAt };
  }
  // REQ §13.179 (c): a pickup from the ride's destination back to its start rides the way back — the ride waits by ending later.
  if (preview.waitEndsAt && preview.joinerDepartAt && preview.wantedDepartAt) {
    return { side: "return", eta: preview.joinerDepartAt, wanted: preview.wantedDepartAt, startsAt: null, endsAt: preview.waitEndsAt };
  }
  if (preview.waitStartsAt && preview.joinerDepartAt && preview.wantedDepartAt) {
    return { side: "out", eta: preview.joinerDepartAt, wanted: preview.wantedDepartAt, startsAt: preview.waitStartsAt, endsAt: null };
  }
  return null;
}

/** Who the member must have talked to when the merge is not direct: the guest (their time changes), the guest's driver, the other riders. */
export function memberMergeAgreeNames(preview: MemberMergePreview, wait: boolean): string[] {
  const guestTimeChanges = !(preview.timeKept || (wait && preview.waitKeepsTime));
  return [...new Set([
    ...(guestTimeChanges || preview.sourceDriverName ? [preview.guestName] : []),
    ...(preview.sourceDriverName ? [preview.sourceDriverName] : []),
    ...preview.otherRiders,
  ].filter(Boolean))];
}
