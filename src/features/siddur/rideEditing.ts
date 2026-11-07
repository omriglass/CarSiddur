import { fromZonedTime } from "date-fns-tz";
import { formatMinutes } from "@/components/timeField15Format";
import { TZ, dateKey } from "@/lib/time";
import type { BoardRide } from "./api";
import type { RideMove } from "@/features/rides/api";

/** Use the ride's original Jerusalem day, ending no later than 23:59. */
export function moveOnRideDay(ride: BoardRide, carId: string, startMinutes: number, endMinutes: number): RideMove | null {
  if (!ride.id || !ride.starts_at || ride.version == null || !Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)
    || startMinutes % 15 !== 0 || (endMinutes % 15 !== 0 && endMinutes !== 1439) || startMinutes < 0 || endMinutes > 1439 || endMinutes <= startMinutes) return null;
  const day = dateKey(ride.starts_at);
  const at = (minutes: number) => fromZonedTime(`${day}T${formatMinutes(minutes)}:00`, TZ).toISOString();
  return { rideId: ride.id, carId, startsAt: at(startMinutes), endsAt: at(endMinutes), expectedVersion: ride.version };
}

export function conflictingRides(move: RideMove, rides: readonly BoardRide[], bufferMinutes: number): BoardRide[] {
  return rides.filter((r) => r.id !== move.rideId && r.car_id === move.carId && r.starts_at && r.ends_at &&
    Date.parse(move.startsAt) < Date.parse(r.ends_at) + bufferMinutes * 60_000 &&
    Date.parse(move.endsAt) + bufferMinutes * 60_000 > Date.parse(r.starts_at));
}

/**
 * REQ §13.190: when the only rides in the way are the car's next ones, starting less than the turnaround after the
 * move ends (not overlapping it), the member may go ahead after "תיאמתם עם X…?" — returns the first of them; else null.
 */
export function shortTurnaroundNextRide(move: RideMove, rides: readonly BoardRide[], bufferMinutes: number): BoardRide | null {
  const conflicts = conflictingRides(move, rides, bufferMinutes);
  const end = Date.parse(move.endsAt);
  if (!conflicts.length || !conflicts.every((r) => Date.parse(r.starts_at as string) >= end)) return null;
  return [...conflicts].sort((a, b) => Date.parse(a.starts_at as string) - Date.parse(b.starts_at as string))[0] ?? null;
}
