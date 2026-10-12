// REQ §13.129 (a): a private car's owner may move ANY member's ride onto their own private car. Pure client mirror of the
// server's conditions (`edit_ride` decides for real) — used to show the ride-sheet button and to allow the drag.
import { dateKey } from "@/lib/time";

import { isRideDayEditable } from "./rideDayEditable";
import { servedOf } from "./servedOf";

import type { BoardRide } from "./api";

export interface OwnCarMoveInput {
  ride: Pick<BoardRide, "id" | "car_id" | "starts_at" | "status" | "served" | "version">;
  /** My active, non-retired private cars in this department. */
  myCarIds: readonly string[];
  /** The ride's week is published/live and its day is a published day. */
  dayPublished: boolean;
  now: Date;
}

/** The ids of my private cars this ride can be moved onto (empty = the ride does not qualify). */
export function ownCarMoveTargets({ ride, myCarIds, dayPublished, now }: OwnCarMoveInput): string[] {
  if (!ride.id || ride.version == null || !dayPublished || ride.status === "cancelled") return [];
  if (!isRideDayEditable(ride.starts_at, now)) return [];
  if (servedOf(ride as BoardRide).some((entry) => entry.car_mode === "relay")) return [];
  return myCarIds.filter((carId) => carId !== ride.car_id);
}

/** True when the ride can be moved onto at least one of my private cars. */
export function canMoveOntoMyCar(input: OwnCarMoveInput): boolean {
  return ownCarMoveTargets(input).length > 0;
}

/** The ride's week is published/live and the ride's day is one of its published days. */
export function rideDayPublished(week: { phase: string; published_days?: readonly string[] | null } | null | undefined, startsAt: string | null | undefined): boolean {
  if (!week || !startsAt || (week.phase !== "published" && week.phase !== "live")) return false;
  return week.published_days?.includes(dateKey(startsAt)) ?? true;
}
