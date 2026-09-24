import { he, tv } from "@/i18n/he";

import type { CarSwapBlocker, CarSwapRide } from "./schema";

/** The moved ride's own label, falling back to the driver's name, then a bare "הנסיעה" (owner A4: every blocker names the ride when it can). */
export function carSwapRideLabel(ride: CarSwapRide | undefined): string {
  if (!ride) return he.carSwap.unknownRide;
  return ride.label ?? ride.driver_name ?? he.carSwap.unknownRide;
}

/**
 * One blocker → one Hebrew sentence (REQ §13.92 A4). Pure — takes the
 * preview's own `rides`/car-name lookup rather than re-fetching anything, so
 * it is unit-testable on its own and reusable by both the dialog's body and
 * (if ever needed) a toast. `blocker.detail` is never rendered directly:
 * SQL/RPC output outside `notification_templates` carries no Hebrew (CLAUDE.md
 * hard rule 3), so the message is built entirely from the blocker's `code`
 * plus the ride/car it names.
 */
export function carSwapBlockerMessage(
  blocker: CarSwapBlocker,
  rides: readonly CarSwapRide[],
  carNameById: Readonly<Record<string, string>>,
): string {
  const ride = blocker.ride_id ? rides.find((r) => r.ride_id === blocker.ride_id) : undefined;
  const rideLabel = carSwapRideLabel(ride);
  const carName = blocker.car_id ? (carNameById[blocker.car_id] ?? "") : "";
  switch (blocker.code) {
    case "seats":
      return tv("carSwap.blockerSeats", { ride: rideLabel, car: carName });
    case "maintenance":
      return tv("carSwap.blockerMaintenance", { car: carName, ride: rideLabel });
    case "private_car":
      return he.carSwap.blockerPrivateCar;
    case "past":
      return tv("carSwap.blockerPast", { ride: rideLabel });
    case "not_allowed":
    default:
      return blocker.ride_id ? tv("carSwap.blockerNotAllowedRide", { ride: rideLabel }) : he.carSwap.blockerNotAllowedGeneric;
  }
}
