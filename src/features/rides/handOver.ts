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

/**
 * REQ item 229: who may take the wheel when `leaverId` (the driver) leaves a merged ride — anyone on it who drives and
 * rides it both ways (another member whose request it serves, a companion, a person added to it), and whether the
 * "no driver" choice applies. When the leaver's own request carries other people only its companions may take it over.
 * `null` when the ride is not a merge the leaver drives. Mirrors `leave_merged_ride` (the RPC decides for real).
 */
export function mergedLeaveOptions(
  ride: Pick<BoardRide, "driver_id" | "status" | "series_id" | "served" | "people">,
  leaverId: string | null | undefined,
  members: readonly HandOverMember[],
): { candidates: HandOverCandidate[]; noDriver: boolean } | null {
  if (!leaverId || ride.driver_id !== leaverId || ride.status === "cancelled" || ride.series_id) return null;
  const people = peopleOf(ride as BoardRide);
  const mine = new Set(people.filter((p) => p.person_id === leaverId && (p.source === "driver" || p.source === "requester") && p.request_id)
    .map((p) => p.request_id as string));
  const merged = people.some((p) => p.source === "requester" && !!p.person_id && p.person_id !== leaverId && !!p.request_id && !mine.has(p.request_id));
  if (!merged) return null;
  const mineCarriesOthers = people.some((p) => (p.source === "companion" || p.source === "child") && !!p.request_id && mine.has(p.request_id));
  // Q5 (owner 2026-11-14): never a rider at the wheel of a הקפצה — the rider is the one being driven (server: the same refusal).
  const dropOff = servedOf(ride as BoardRide).some((s) => s.trip_type === "drop_off");
  if (dropOff) return { candidates: [], noDriver: !mineCarriesOthers };
  const byId = new Map(members.map((member) => [member.id, member]));
  const seen = new Set<string>();
  const candidates: HandOverCandidate[] = [];
  for (const person of people) {
    if (!person.person_id || person.person_id === leaverId || seen.has(person.person_id)) continue;
    const onMine = !!person.request_id && mine.has(person.request_id);
    if (mineCarriesOthers ? !(person.source === "companion" && onMine)
      : !(person.source === "requester" || person.source === "companion" || person.source === "added") || onMine) continue;
    if ((person.leg ?? "both") !== "both") continue;
    const member = byId.get(person.person_id);
    if (!member || member.doesNotDrive) continue;
    seen.add(person.person_id);
    candidates.push({ id: member.id, name: member.name });
  }
  return { candidates, noDriver: !mineCarriesOthers };
}
