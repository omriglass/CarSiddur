import type { JoinableRideRow } from "./api";

/**
 * F4 (docs/TODO.md, owner answers A8-A10): `JoinableRidesDialog`'s row subtitle falls back to
 * the car's name when the ride has no assigned driver yet (`joinable_rides_for_request`'s
 * `driver_name` is `''` for a still-unclaimed chauffeur ride) — never a phone number (REQ §10),
 * "ask to join" is the contact channel.
 */
export function joinableRideDriverLabel(row: Pick<JoinableRideRow, "driverName" | "carName">): string {
  return row.driverName || row.carName;
}
