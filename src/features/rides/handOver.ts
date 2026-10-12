// REQ §13.129 (b): a ride's driver hands their own ride to someone on it who drives (`hand_over_own_ride`). Pure client
// mirror of the server's candidate rule (the RPC decides for real).
import { peopleOf } from "./ridePeople";
import { servedOf } from "./servedOf";

import type { BoardRide } from "./api";

export interface HandOverMember {
  id: string;
  name: string;
  doesNotDrive: boolean;
}

export interface HandOverCandidate {
  id: string;
  name: string;
}

/**
 * Companions named on the driver's request and passengers added to the ride (with a person id) who drive — only when I drive the
 * ride, it serves only my own request(s) and it is not a multi-day series.
 */
export function handOverCandidates(
  ride: Pick<BoardRide, "driver_id" | "status" | "series_id" | "served" | "people">,
  profileId: string | undefined,
  myRequestIds: ReadonlySet<string>,
  members: readonly HandOverMember[],
): HandOverCandidate[] {
  if (!profileId || ride.driver_id !== profileId || ride.status === "cancelled" || ride.series_id) return [];
  const served = servedOf(ride as BoardRide);
  if (!served.length || !served.every((entry) => !!entry.request_id && myRequestIds.has(entry.request_id))) return [];
  const byId = new Map(members.map((member) => [member.id, member]));
  const seen = new Set<string>();
  const out: HandOverCandidate[] = [];
  for (const person of peopleOf(ride)) {
    if ((person.source !== "companion" && person.source !== "added") || !person.person_id) continue;
    if (person.person_id === profileId || seen.has(person.person_id)) continue;
    const member = byId.get(person.person_id);
    if (!member || member.doesNotDrive) continue;
    seen.add(person.person_id);
    out.push({ id: member.id, name: member.name });
  }
  return out;
}
