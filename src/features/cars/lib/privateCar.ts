/** The slice of a ride the "make private" warning needs. */
export interface UpcomingCarRide {
  id: string;
  driver_id: string | null;
}

/** Upcoming rides that a private car's owner would not be the driver of (REQ: warn, never block). */
export function ridesNeedingWarning(rides: readonly UpcomingCarRide[], ownerId: string | null): UpcomingCarRide[] {
  if (!ownerId) return [...rides];
  return rides.filter((ride) => ride.driver_id !== ownerId);
}
