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
  opts: {
    awaitingDriverRequestIds: ReadonlySet<string | null>;
    draftPlacedRequestIds: ReadonlySet<string | null>;
    /**
     * Owner 2026-10-23: a sent/accepted merge already shows as its block on the host's car, so the guest's card for
     * those legs is not listed a second time (`both` covers both legs; a one-leg merge leaves the other leg's card).
     */
    boardShownLegs?: ReadonlyMap<string, ReadonlySet<"out" | "return" | "both">>;
  },
): UnmetRequestView[] {
  const views: UnmetRequestView[] = [];
  for (const request of requests) {
    if (opts.draftPlacedRequestIds.has(request.id)) continue;
    const shown = opts.boardShownLegs?.get(request.id);
    const legShown = (leg: "out" | "return") => !!shown && (shown.has("both") || shown.has(leg));
    if (isDropOffWithPickup(request) && (isUnmetStatus(request.status) || PARTLY_PLACED_STATUSES.has(request.status) || opts.awaitingDriverRequestIds.has(request.id))) {
      if (request.status === "denied" || request.status === "external") { views.push({ request }); continue; }
      const covered = coveredLegs(rides, request.id);
      if (covered.out && covered.return) continue;
      if (!covered.out && !legShown("out")) views.push({ request: legView(request, "out"), leg: "out" });
      if (!covered.return && !legShown("return")) views.push({ request: legView(request, "return"), leg: "return" });
      continue;
    }
    // RC1B2 (QA concurrency run 1): a round trip placed or merged on one leg only (an "out only" merge) still needs its
    // other leg - that leg is an unmet card of its own instead of disappearing from the list. Its virtual view is a
    // הקפצה leg, so placing it books that leg alone (a chauffeur leg, or a merge onto a ride's leg), never the whole trip.
    if (PARTLY_PLACED_STATUSES.has(request.status) && request.depart_at && request.return_at) {
      const covered = coveredLegs(rides, request.id);
      const missing: UnmetLeg | null = covered.out && !covered.return ? "return" : covered.return && !covered.out ? "out" : null;
      if (missing && !legShown(missing)) views.push({ request: { ...legView(request, missing), trip_type: "drop_off" }, leg: missing });
      continue;
    }
    if (isUnmetStatus(request.status) && !opts.awaitingDriverRequestIds.has(request.id) && !shown?.size) views.push({ request });
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

/**
 * REQ §13.101 (k): the other half of a connected הקפצה pair `ride` belongs to (same car, same
 * request, the opposite leg), with each ride's own leg; `null` when `ride` is not half of a pair.
 */
export function connectedMateOf(rides: readonly BoardRide[], ride: BoardRide): { mate: BoardRide; rideLeg: "out" | "return"; mateLeg: "out" | "return" } | null {
  if (!ride.id || !connectedPairRideIds(rides).has(ride.id)) return null;
  for (const entry of servedOf(ride)) {
    if (!entry.request_id || (entry.leg !== "out" && entry.leg !== "return")) continue;
    const mate = rides.find((other) => other.id !== ride.id && other.car_id === ride.car_id && other.status !== "cancelled"
      && servedOf(other).some((e) => e.request_id === entry.request_id && e.leg !== entry.leg && (e.leg === "out" || e.leg === "return")));
    if (mate) return { mate, rideLeg: entry.leg, mateLeg: entry.leg === "out" ? "return" : "out" };
  }
  return null;
}
