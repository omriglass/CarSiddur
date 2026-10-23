// R2U3: who is busy when a volunteer driver is picked for a ride - members with another ride of
// their own (as driver, requester or listed person) or a live request of their own overlapping
// the ride's window. Pure; the picker marks them and sorts the free ones first.
import { peopleOf } from "@/features/rides/ridePeople";
import { servedOf } from "@/features/rides/servedOf";
import { dateKey } from "@/lib/time";

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

/** R13F2: one of a person's other rides (or still-unplaced requests) on the day of the ride a driver is picked for. */
export interface PersonDayEntry {
  kind: "drives" | "rides" | "request";
  startsAt: string;
  endsAt: string;
  /** Where to, when known (the person's own request, else the ride's first request). */
  destination: string | null;
  /** Overlaps the ride being assigned (what made the person "busy"). */
  overlaps: boolean;
}

/**
 * R13F2 (QA run 13): the person's other rides and unplaced requests on `ride`'s Jerusalem day, by time - so the
 * Sadran sees WHAT a candidate driver already has that day (a pickup later, a ride that clashes), not only "busy".
 */
export function personDayEntries(
  personId: string,
  ride: Pick<BoardRide, "id" | "starts_at" | "ends_at">,
  rides: readonly BoardRide[],
  requests: readonly WeekRequestRow[],
): PersonDayEntry[] {
  if (!ride.starts_at || !ride.ends_at) return [];
  const day = dateKey(ride.starts_at);
  const start = Date.parse(ride.starts_at);
  const end = Date.parse(ride.ends_at);
  const destinationOf = (requestId: string | null | undefined) =>
    requests.find((request) => request.id === requestId)?.destination_resolved_name ?? null;
  const entries: PersonDayEntry[] = [];
  const onRides = new Set<string>();
  for (const other of rides) {
    if (other.id === ride.id || other.status === "cancelled" || !other.starts_at || !other.ends_at || dateKey(other.starts_at) !== day) continue;
    const drives = other.driver_id === personId;
    if (!drives && !peopleOf(other).some((person) => person.person_id === personId)) continue;
    const served = servedOf(other);
    served.forEach((entry) => { if (entry.request_id) onRides.add(entry.request_id); });
    const own = served.find((entry) => requests.some((request) => request.id === entry.request_id && request.requester_id === personId));
    entries.push({ kind: drives ? "drives" : "rides", startsAt: other.starts_at, endsAt: other.ends_at,
      destination: destinationOf((own ?? served[0])?.request_id),
      overlaps: overlaps(start, end, Date.parse(other.starts_at), Date.parse(other.ends_at)) });
  }
  for (const request of requests) {
    if (request.requester_id !== personId || DEAD_REQUEST_STATUSES.has(request.status) || onRides.has(request.id)) continue;
    const window = requestWindow(request);
    if (!window || dateKey(window.startsAt) !== day) continue;
    entries.push({ kind: "request", startsAt: window.startsAt, endsAt: window.endsAt, destination: request.destination_resolved_name ?? null,
      overlaps: overlaps(start, end, Date.parse(window.startsAt), Date.parse(window.endsAt)) });
  }
  return entries.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.kind.localeCompare(b.kind));
}

/** Free members first, then busy ones; each group keeps its incoming order. */
export function sortFreeFirst<T extends { id: string }>(candidates: readonly T[], busy: ReadonlySet<string>): T[] {
  return [...candidates.filter((c) => !busy.has(c.id)), ...candidates.filter((c) => busy.has(c.id))];
}

/** R14U2: the picker's search box (name, case-insensitive) and "free only" toggle (hides people busy in the ride's window). */
export function filterDriverCandidates<T extends { id: string; name: string }>(
  candidates: readonly T[],
  query: string,
  freeOnly: boolean,
  busy: ReadonlySet<string>,
): T[] {
  const needle = query.trim().toLowerCase();
  return candidates.filter((c) => (!needle || c.name.toLowerCase().includes(needle)) && !(freeOnly && busy.has(c.id)));
}

/**
 * Ride ids whose driver is also the driver of another non-cancelled ride with an overlapping
 * half-open window - a warning only (owner 2026-10-16: never blocks publishing). Marks only;
 * drafts count (the board shows them), nothing is blocked.
 */
export function driverOverlapRideIds(
  rides: readonly Pick<BoardRide, "id" | "driver_id" | "status" | "starts_at" | "ends_at">[],
): Set<string> {
  const result = new Set<string>();
  const byDriver = new Map<string, { id: string; start: number; end: number }[]>();
  for (const ride of rides) {
    if (!ride.id || !ride.driver_id || ride.status === "cancelled" || !ride.starts_at || !ride.ends_at) continue;
    const list = byDriver.get(ride.driver_id) ?? [];
    list.push({ id: ride.id, start: Date.parse(ride.starts_at), end: Date.parse(ride.ends_at) });
    byDriver.set(ride.driver_id, list);
  }
  for (const list of byDriver.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (overlaps(list[i]!.start, list[i]!.end, list[j]!.start, list[j]!.end)) {
          result.add(list[i]!.id);
          result.add(list[j]!.id);
        }
      }
    }
  }
  return result;
}
