// CM1 phase 4 (REQ item 260 d): after a ride is placed or moved next to another ride with the same person on it, the app
// offers "לאחד את הנסיעות?". Pure detection over the week already loaded (no reads); the server's merge check then
// decides whether the two really chain before anyone is asked.
import type { BoardRide } from "./api";
import { peopleOf } from "./ridePeople";
import { isReservation, servedOf } from "./servedOf";
import { dateKey } from "@/lib/time";

/** A trip as the detection sees it: one round-trip request, its window, where it starts, who is on it. */
export interface ChainTrip {
  rideId: string | null;
  requestId: string;
  startsAt: string;
  endsAt: string;
  originId: string | null;
  /** 'p:<profile>' / 'c:<child>' — the driver, the requester, companions, children (of everyone on the ride). */
  people: readonly string[];
  /** R22U1: the trip is the only one on its ride, so it can move onto the other ride (a ride with others stays put). */
  alone: boolean;
}

/**
 * The ride's own trip: its base round-trip request (the driver's, else the first), the only kind that chains. R22U1 (owner
 * 2026-11-22): a ride carrying other people's trips too still counts — it is offered when the other side is alone.
 */
export function chainTripOf(ride: BoardRide): ChainTrip | null {
  if (!ride.id || !ride.starts_at || !ride.ends_at || ride.status === "cancelled" || isReservation(ride)) return null;
  const served = servedOf(ride).filter((entry) => entry.request_id);
  if (!served.length) return null;
  const entry = served.find((candidate) => candidate.role === "driver") ?? served[0]!;
  if (entry.leg !== "both" || (entry.trip_type && entry.trip_type !== "round_trip")) return null;
  return {
    rideId: ride.id, requestId: entry.request_id as string, startsAt: ride.starts_at, endsAt: ride.ends_at,
    originId: entry.origin_id ?? ride.origin_id ?? null, people: personKeys(ride), alone: served.length === 1,
  };
}

export function personKeys(ride: Pick<BoardRide, "people" | "driver_id">): string[] {
  const keys = new Set<string>();
  if (ride.driver_id) keys.add(`p:${ride.driver_id}`);
  for (const person of peopleOf(ride)) {
    if (person.source === "child") { if (person.child_id) keys.add(`c:${person.child_id}`); continue; }
    if (!person.person_id) continue;
    if (person.source === "driver" || person.source === "requester" || person.source === "companion") keys.add(`p:${person.person_id}`);
  }
  return [...keys];
}

/**
 * The rides next to `trip` that share a person with it — any car, the same day, one ending at most turnaround + an hour's
 * drive after the other starts and at most two hours before it (the server's `_merge_chain_plan` rule, with the drive
 * between them taken as its default hour). Nearest first. `skip`: pairs already declined this session.
 */
export function chainNeighbours(trip: ChainTrip, rides: readonly BoardRide[], turnaroundMinutes: number, skip?: ReadonlySet<string>): ChainTrip[] {
  const day = dateKey(trip.startsAt);
  const mine = new Set(trip.people);
  const found: { other: ChainTrip; gap: number }[] = [];
  for (const ride of rides) {
    if (ride.id === trip.rideId) continue;
    const other = chainTripOf(ride);
    if (!other || other.requestId === trip.requestId || dateKey(other.startsAt) !== day) continue;
    if (skip?.has(chainPairKey(trip.requestId, other.requestId))) continue;
    if (!trip.originId || other.originId !== trip.originId) continue;
    if (!other.people.some((key) => mine.has(key))) continue;
    if (!trip.alone && !other.alone) continue;   // neither trip can move without leaving others behind
    const [first, second] = Date.parse(trip.startsAt) <= Date.parse(other.startsAt) ? [trip, other] : [other, trip];
    const gap = (Date.parse(second.startsAt) - Date.parse(first.endsAt)) / 60_000;
    if (gap < -(turnaroundMinutes + 60) || gap > 120) continue;
    found.push({ other, gap: Math.abs(gap) });
  }
  return found.sort((a, b) => a.gap - b.gap || a.other.requestId.localeCompare(b.other.requestId)).map((f) => f.other);
}

/** One key per pair of requests, either order. */
export function chainPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
