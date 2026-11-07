import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";

import type { CarSwapBlocker, CarSwapRide } from "./schema";

/**
 * The moved ride as "who to where" ("אגתה לתל יצחק", REQ §13.186 c), else whichever half is known, then a bare
 * "הנסיעה" (owner A4: every blocker names the ride when it can).
 */
export function carSwapRideLabel(ride: CarSwapRide | undefined): string {
  if (!ride) return he.carSwap.unknownRide;
  const person = ride.person_name ?? ride.driver_name;
  if (person && ride.label) return tv("carSwap.rideLabel", { person, place: ride.label });
  return person ?? ride.label ?? he.carSwap.unknownRide;
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
    case "luggage":
      return tv("carSwap.blockerLuggage", { ride: rideLabel, car: carName });
    case "series_other_day_busy":
      return tv("carSwap.blockerSeriesOtherDayBusy", {
        car: carName,
        day: blocker.day ? formatDayDate(blocker.day) : "",
        time: blocker.starts_at && blocker.ends_at ? `${formatTime(new Date(blocker.starts_at))}–${formatTime(new Date(blocker.ends_at))}` : "",
      });
    case "overlap":
      return tv("carSwap.blockerOverlap", {
        ride: rideLabel, car: carName,
        time: blocker.starts_at && blocker.ends_at ? `${formatTime(new Date(blocker.starts_at))}–${formatTime(new Date(blocker.ends_at))}` : "",
      });
    case "private_car":
      return he.carSwap.blockerPrivateCar;
    case "swap_too_large":
      return tv("carSwap.blockerSwapTooLarge", { rides: String(blocker.rides ?? 0), days: String(blocker.days ?? 0) });
    case "archived":
      return tv("carSwap.blockerArchived", { ride: rideLabel });
    case "past":
      return tv("carSwap.blockerPast", { ride: rideLabel });
    case "not_allowed":
    default:
      return blocker.ride_id ? tv("carSwap.blockerNotAllowedRide", { ride: rideLabel }) : he.carSwap.blockerNotAllowedGeneric;
  }
}
