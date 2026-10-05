import type { MyRequestRow } from "./api";

/**
 * REQ §13.101 g (QM7): what "cancel the other one" means for the member's own overlapping
 * request. A request that already has a ride is cancelled through the ride (`cancel_ride`,
 * `withdraw_request` refuses it with `request_has_ride`); any other is simply withdrawn.
 */
export type OverlapCancelAction =
  | { kind: "cancelRide"; rideId: string; expectedVersion: number | undefined }
  | { kind: "withdraw"; requestId: string; expectedVersion: number };

export function overlapCancelAction(row: Pick<MyRequestRow, "id" | "version" | "ride">): OverlapCancelAction {
  if (row.ride && row.ride.status !== "cancelled") {
    return { kind: "cancelRide", rideId: row.ride.id, expectedVersion: row.ride.version };
  }
  return { kind: "withdraw", requestId: row.id, expectedVersion: row.version };
}

/** REQ §13.101 h (QM8): which requests may be put on the member's own private car. */
export function canPlaceOnOwnCar(
  row: Pick<MyRequestRow, "status" | "tripType" | "ride">,
  ownCarCount: number,
): boolean {
  return ownCarCount > 0 && !row.ride && row.tripType === "round_trip" && ["waitlisted", "denied", "external"].includes(row.status);
}

/** REQ §13.101 e (QM4). */
export function isDuplicateWithdrawn(row: Pick<MyRequestRow, "status" | "statusReason">): boolean {
  return row.status === "withdrawn" && row.statusReason === "DUPLICATE_WITHDRAWN";
}
