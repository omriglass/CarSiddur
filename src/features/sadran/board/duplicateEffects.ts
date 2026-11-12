// What withdrawing a request as a duplicate removes from the board (production 2026-11-12: a Sadran withdrew
// a request whose way there had just been merged into another member's ride, and the merge went with it).
// `withdraw_duplicate_request` releases every leg, so the confirmation names each ride that changes.
import type { BoardRide } from "@/features/rides/api";
import { servedOf } from "@/features/rides/servedOf";

export interface DuplicateEffect {
  rideId: string;
  startsAt: string;
  /** `guest`: the request rides in someone else's ride and leaves it. `own`: the request's own ride is cancelled. */
  kind: "guest" | "own";
  /** The other ride's driver, for `guest`. */
  driverName: string | null;
}

export function duplicateEffects(rides: readonly BoardRide[], requestId: string): DuplicateEffect[] {
  const effects: DuplicateEffect[] = [];
  for (const ride of rides) {
    if (!ride.id || !ride.starts_at || ride.status === "cancelled") continue;
    const served = servedOf(ride);
    const mine = served.find((entry) => entry.request_id === requestId);
    if (!mine) continue;
    const others = served.some((entry) => entry.request_id !== requestId);
    effects.push({
      rideId: ride.id,
      startsAt: ride.starts_at,
      kind: others && mine.role === "passenger" ? "guest" : "own",
      driverName: ride.driver_name ?? null,
    });
  }
  return effects.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.rideId.localeCompare(b.rideId));
}
