// R2U3: who is busy when a volunteer driver is picked for a ride - members with another ride of
// their own (as driver, requester or listed person) or a live request of their own overlapping
// the ride's window. Pure; the picker marks them and sorts the free ones first.
import { peopleOf } from "@/features/rides/ridePeople";

import { requestWindow } from "./phantomLanes";

import type { BoardRide, WeekRequestRow } from "../api";

const DEAD_REQUEST_STATUSES = new Set(["draft", "withdrawn", "cancelled", "denied", "external"]);

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Profile ids that are busy during `ride`'s window (the ride itself does not count). */
export function busyDriverIds(
  ride: Pick<BoardRide, "id" | "starts_at" | "ends_at">,
  rides: readonly BoardRide[],
  requests: readonly WeekRequestRow[],
): Set<string> {
  const busy = new Set<string>();
  if (!ride.starts_at || !ride.ends_at) return busy;
  const start = Date.parse(ride.starts_at);
  const end = Date.parse(ride.ends_at);
  for (const other of rides) {
    if (other.id === ride.id || other.status === "cancelled" || !other.starts_at || !other.ends_at) continue;
    if (!overlaps(start, end, Date.parse(other.starts_at), Date.parse(other.ends_at))) continue;
    if (other.driver_id) busy.add(other.driver_id);
    for (const person of peopleOf(other)) if (person.person_id) busy.add(person.person_id);
  }
  for (const request of requests) {
    if (DEAD_REQUEST_STATUSES.has(request.status) || !request.requester_id) continue;
    const window = requestWindow(request);
    if (window && overlaps(start, end, Date.parse(window.startsAt), Date.parse(window.endsAt))) busy.add(request.requester_id);
  }
  return busy;
}

/** Free members first, then busy ones; each group keeps its incoming order. */
export function sortFreeFirst<T extends { id: string }>(candidates: readonly T[], busy: ReadonlySet<string>): T[] {
  return [...candidates.filter((c) => !busy.has(c.id)), ...candidates.filter((c) => busy.has(c.id))];
}
