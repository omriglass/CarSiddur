import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { formatMinutes } from "@/components/TimeField15";
import { TZ } from "@/lib/time";
import type { BoardRide, RideMove } from "./api";

/** Use the ride's original Jerusalem day, ending no later than 23:59. */
export function moveOnRideDay(ride: BoardRide, carId: string, startMinutes: number, endMinutes: number): RideMove | null {
  if (!ride.id || !ride.starts_at || ride.version == null || !Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)
    || startMinutes % 15 !== 0 || (endMinutes % 15 !== 0 && endMinutes !== 1439) || startMinutes < 0 || endMinutes > 1439 || endMinutes <= startMinutes) return null;
  const day = formatInTimeZone(ride.starts_at, TZ, "yyyy-MM-dd");
  const at = (minutes: number) => fromZonedTime(`${day}T${formatMinutes(minutes)}:00`, TZ).toISOString();
  return { rideId: ride.id, carId, startsAt: at(startMinutes), endsAt: at(endMinutes), expectedVersion: ride.version };
}

export function conflictingRides(move: RideMove, rides: readonly BoardRide[], bufferMinutes: number): BoardRide[] {
  return rides.filter((r) => r.id !== move.rideId && r.car_id === move.carId && r.starts_at && r.ends_at &&
    Date.parse(move.startsAt) < Date.parse(r.ends_at) + bufferMinutes * 60_000 &&
    Date.parse(move.endsAt) + bufferMinutes * 60_000 > Date.parse(r.starts_at));
}
