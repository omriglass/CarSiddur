import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { formatMinutes } from "@/components/TimeField15";
import { TZ } from "@/lib/time";
import type { BoardRide, RideMove } from "./api";

/** Use the ride's original Jerusalem day, including a correct midnight endpoint. */
export function moveOnRideDay(ride: BoardRide, carId: string, startMinutes: number, endMinutes: number): RideMove | null {
  if (!ride.id || !ride.starts_at || ride.version == null || !Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)
    || startMinutes % 15 !== 0 || endMinutes % 15 !== 0 || startMinutes < 0 || endMinutes > 1440 || endMinutes <= startMinutes) return null;
  const day = formatInTimeZone(ride.starts_at, TZ, "yyyy-MM-dd");
  const at = (minutes: number) => {
    if (minutes === 1440) {
      const next = new Date(`${day}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      return fromZonedTime(`${next.toISOString().slice(0, 10)}T00:00:00`, TZ).toISOString();
    }
    return fromZonedTime(`${day}T${formatMinutes(minutes)}:00`, TZ).toISOString();
  };
  return { rideId: ride.id, carId, startsAt: at(startMinutes), endsAt: at(endMinutes), expectedVersion: ride.version };
}

export function conflictingRides(move: RideMove, rides: readonly BoardRide[], bufferMinutes: number): BoardRide[] {
  return rides.filter((r) => r.id !== move.rideId && r.car_id === move.carId && r.starts_at && r.ends_at &&
    Date.parse(move.startsAt) < Date.parse(r.ends_at) + bufferMinutes * 60_000 &&
    Date.parse(move.endsAt) + bufferMinutes * 60_000 > Date.parse(r.starts_at));
}
