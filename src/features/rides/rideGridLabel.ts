import { rideBlockLabel } from "@/lib/rideLabel";
import { viaLabel } from "@/lib/routeLabel";

import type { BoardRide } from "./api";
import { rideViaNames, servedOf } from "./servedOf";

/**
 * The one line that says whose ride it is and where it goes - the siddur's grid block and list card, and (owner
 * 2026-11-17) the "my rides" card. Places in the middle are folded in ("חבר ל-זכרון יעקב, בנימינה. חזור: …").
 * `notesAsLabel`: the siddur names a time hold (no request behind it) by its notes; "my rides" always says the
 * driver and the place and shows the notes under it.
 */
export function rideGridLabel(ride: BoardRide, homeDestinationId: string | null | undefined, { notesAsLabel = true } = {}): string {
  const served = servedOf(ride);
  if (notesAsLabel && !served.length && ride.notes) return ride.notes;
  if (!(homeDestinationId && ride.origin_id && ride.destination_id)) {
    const via = viaLabel(rideViaNames(ride));
    return via ? `${ride.destination_name ?? ""} · ${via}` : (ride.destination_name ?? "");
  }
  return rideBlockLabel({
    via: rideViaNames(ride),
    originId: ride.origin_id,
    destinationId: ride.destination_id,
    originName: ride.origin_name ?? "",
    destinationName: ride.destination_name ?? "",
    homeDestinationId,
    served,
    driverName: ride.driver_name,
    isChauffeur: !!ride.is_chauffeur,
    needsDriver: !!ride.needs_driver,
    autoRelocation: !!ride.auto_relocation,
    carMove: ride.pin_reason === "CAR_MOVE",
    startsAt: ride.starts_at ?? undefined,
  });
}
