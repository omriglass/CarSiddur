// REQ §13.94 (G4): a drop-off (הקפצה) with a pickup is two separate trips. On the board it shows
// as two placeable cards - the drop-off (`out`) and the pickup (`return`) - each placed
// independently as a chauffeur leg. Each card carries a *virtual one-leg view* of the request
// (same id; `trip_shape` one_way_to / one_way_from) so every existing placement rule (window,
// origin, chauffeur candidates, shift payload) keys off the leg without change.
// A leg that a ride already covers no longer shows. Pure: no React, no Supabase.
import { isUnmetStatus } from "../unmetStatuses";
import { servedOf } from "../applySolve";
import { requestStart, tripTypeOf } from "./phantomLanes";

import type { BoardRide, WeekRequestRow } from "../api";

export type UnmetLeg = "out" | "return";

export interface UnmetRequestView {
  /** The request, or its virtual one-leg view for a split drop-off. */
  request: WeekRequestRow;
  /** Set only for the two cards of a split drop-off. */
  leg?: UnmetLeg;
}

/** Stable id of a card: the request id, `:return` appended for the pickup card. */
export function unmetItemKey(item: { request: { id: string }; leg?: UnmetLeg }): string {
  return `${item.request.id}${item.leg === "return" ? ":return" : ""}`;
}

/** The grid/phantom id of a card (`request:<key>`). */
export function unmetItemId(item: { request: { id: string }; leg?: UnmetLeg }): string {
  return `request:${unmetItemKey(item)}`;
}

/** A drop-off that also asks to be picked up: stored as one round-trip-shaped request. */
export function isDropOffWithPickup(request: Pick<WeekRequestRow, "trip_shape"> & { trip_type?: WeekRequestRow["trip_type"] }): boolean {
  return tripTypeOf(request) === "drop_off" && request.trip_shape === "round_trip";
}

/** The legs of `requestId` some live ride already serves. */
export function coveredLegs(rides: readonly BoardRide[], requestId: string): { out: boolean; return: boolean } {
  const covered = { out: false, return: false };
  for (const ride of rides) {
    if (ride.status === "cancelled") continue;
    for (const entry of servedOf(ride)) {
      if (entry.request_id !== requestId) continue;
      if (entry.leg === "out" || entry.leg === "both") covered.out = true;
      if (entry.leg === "return" || entry.leg === "both") covered.return = true;
    }
  }
  return covered;
}

/** One-leg virtual view of a split drop-off. */
export function legView(request: WeekRequestRow, leg: UnmetLeg): WeekRequestRow {
  return leg === "out"
    ? { ...request, trip_shape: "one_way_to", return_at: null }
    : { ...request, trip_shape: "one_way_from", depart_at: null };
}

const PARTLY_PLACED_STATUSES = new Set(["assigned", "merged"]);

/**
 * The board's unmet cards for the week (before the selected-day filter): every unmet request, with
 * a split drop-off appearing once per unplaced leg - even when its other leg already has a ride
 * (that ride may still await a driver, which is exactly why the request is not "unmet" any more).
 */
export function unmetRequestViews(
  requests: readonly WeekRequestRow[],
  rides: readonly BoardRide[],
  opts: { awaitingDriverRequestIds: ReadonlySet<string | null>; draftPlacedRequestIds: ReadonlySet<string | null> },
): UnmetRequestView[] {
  const views: UnmetRequestView[] = [];
  for (const request of requests) {
    if (opts.draftPlacedRequestIds.has(request.id)) continue;
    if (isDropOffWithPickup(request) && (isUnmetStatus(request.status) || PARTLY_PLACED_STATUSES.has(request.status) || opts.awaitingDriverRequestIds.has(request.id))) {
      if (request.status === "denied" || request.status === "external") { views.push({ request }); continue; }
      const covered = coveredLegs(rides, request.id);
      if (covered.out && covered.return) continue;
      if (!covered.out) views.push({ request: legView(request, "out"), leg: "out" });
      if (!covered.return) views.push({ request: legView(request, "return"), leg: "return" });
      continue;
    }
    if (isUnmetStatus(request.status) && !opts.awaitingDriverRequestIds.has(request.id)) views.push({ request });
  }
  return views;
}

/** Keeps the views whose anchor day is `day` (`dateKey` of the departure, or the return for a pickup). */
export function viewsOnDay(views: readonly UnmetRequestView[], day: string, dateKeyOf: (iso: string) => string): UnmetRequestView[] {
  return views.filter((view) => {
    const start = requestStart(view.request);
    return !!start && dateKeyOf(start) === day;
  });
}

/**
 * REQ §13.95 (H2): rides that are the two halves of a connected הקפצה pair - the same request
 * served on two rides of one car, one carrying its `out` leg and the other its `return` leg, both
 * with a driver (the requester). The car waits at the destination between them (the board's away
 * band). Returns the ids of both rides.
 */
export function connectedPairRideIds(rides: readonly BoardRide[]): Set<string> {
  const byRequest = new Map<string, BoardRide[]>();
  for (const ride of rides) {
    if (!ride.id || !ride.car_id || ride.status === "cancelled" || ride.needs_driver || !ride.driver_id) continue;
    for (const entry of servedOf(ride)) {
      if (!entry.request_id || (entry.leg !== "out" && entry.leg !== "return")) continue;
      byRequest.set(entry.request_id, [...(byRequest.get(entry.request_id) ?? []), ride]);
    }
  }
  const ids = new Set<string>();
  for (const [requestId, group] of byRequest) {
    const legOf = (ride: BoardRide) => servedOf(ride).find((entry) => entry.request_id === requestId)?.leg;
    for (const a of group) {
      const b = group.find((other) => other.id !== a.id && other.car_id === a.car_id && legOf(other) !== legOf(a));
      if (b) { ids.add(a.id as string); ids.add(b.id as string); }
    }
  }
  return ids;
}
