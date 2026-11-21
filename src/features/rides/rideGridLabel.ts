import { rideBlockLabel } from "@/lib/rideLabel";
import { ridePassengerParts } from "@/lib/ridePassengerSummary";
import { viaLabel } from "@/lib/routeLabel";

import type { BoardRide } from "./api";
import { addedPeopleNames, riderShortNames } from "./ridePeople";
import { rideViaNames, servedOf } from "./servedOf";

/**
 * The one line that says whose ride it is and where it goes - the siddur's grid block and list card, and (owner
 * 2026-11-17) the "my rides" card. Places in the middle are folded in ("חבר ל- זכרון יעקב, בנימינה. חזור: …").
 * `notesAsLabel`: the siddur names a time hold (no request behind it) by its notes; "my rides" always says the
 * driver and the place and shows the notes under it.
 */
export function rideGridLabel(ride: BoardRide, homeDestinationId: string | null | undefined, { notesAsLabel = true } = {}): string {
  return rideCardLabel(ride, homeDestinationId, { notesAsLabel }).label;
}

/**
 * RP1 (owner 2026-11-21): the card's title and whether it names everyone on the ride. A complex ride's flow sentence
 * (`summary`, `useRideSummaries`) is the title; a simple ride names all its riders ("חבר, נגה וענבר לבנימינה"). When
 * the title names everyone (and nobody rides unnamed), the card drops its "נוסעים" line.
 */
export function rideCardLabel(ride: BoardRide, homeDestinationId: string | null | undefined,
  { notesAsLabel = true, summary }: { notesAsLabel?: boolean; summary?: string } = {}): { label: string; namesEveryone: boolean } {
  const served = servedOf(ride);
  const parts = ridePassengerParts(served, ride.needs_driver ? null : ride.driver_name, { addedNames: addedPeopleNames(ride, served) });
  const unnamed = parts.adults + parts.children > 0;
  if (summary) return { label: summary, namesEveryone: !unnamed };
  const out: { ridersNamed?: boolean } = {};
  const label = rideBaseLabel(ride, homeDestinationId, notesAsLabel, out);
  return { label, namesEveryone: !!out.ridersNamed && !unnamed };
}

function rideBaseLabel(ride: BoardRide, homeDestinationId: string | null | undefined, notesAsLabel: boolean, out: { ridersNamed?: boolean }): string {
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
    riders: riderShortNames(ride),
    out,
  });
}
