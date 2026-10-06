// REQ §13.105 c (R5Q3): the Sadran joins a short הקפצה's two legs into one ride by hand. A request whose out
// leg and pickup leg sit on two separate single-request chauffeur rides can be joined (`join_drop_off_legs`);
// the server decides whether the car is free for the whole span. Pure: no React, no Supabase.
import { servedOf } from "../applySolve";

import type { BoardRide } from "../api";

export interface JoinableLegs {
  requestId: string;
  /** The other leg's ride (the pickup ride when the ride asked about carries the drop-off, and vice versa). */
  otherRideId: string;
}

/** The single request a chauffeur ride carries for exactly one leg, or `null` (shared / both legs / not a chauffeur ride). */
function singleChauffeurLeg(ride: BoardRide): { requestId: string; leg: "out" | "return" } | null {
  if (ride.status === "cancelled") return null;
  const served = servedOf(ride).filter((entry) => entry.request_id);
  const only = served.length === 1 ? served[0]! : null;
  if (!only?.request_id || only.car_mode !== "chauffeur" || (only.leg !== "out" && only.leg !== "return")) return null;
  return { requestId: only.request_id, leg: only.leg };
}

export function joinableDropOffLegs(ride: BoardRide, rides: readonly BoardRide[]): JoinableLegs | null {
  const here = singleChauffeurLeg(ride);
  if (!here || !ride.id) return null;
  for (const other of rides) {
    if (!other.id || other.id === ride.id) continue;
    const there = singleChauffeurLeg(other);
    if (there && there.requestId === here.requestId && there.leg !== here.leg) {
      const startsAt = here.leg === "out" ? ride.starts_at : other.starts_at;
      const returnStarts = here.leg === "out" ? other.starts_at : ride.starts_at;
      const outEnds = here.leg === "out" ? ride.ends_at : other.ends_at;
      // The pickup must start after the drop-off ends (the server refuses otherwise).
      if (!startsAt || !returnStarts || !outEnds || Date.parse(returnStarts) < Date.parse(outEnds)) return null;
      return { requestId: here.requestId, otherRideId: other.id };
    }
  }
  return null;
}
