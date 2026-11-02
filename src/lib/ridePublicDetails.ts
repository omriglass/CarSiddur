import { tv } from "@/i18n/he";

import { rideCarriesBothLegs, withLegMark, type RideLeg } from "./rideLegMark";

export interface RidePublicEntry {
  requester?: string | null;
  ride_description?: string | null;
  guest_passenger_names?: string[];
  companions?: { profile_id: string; name: string }[];
  /** Named children traveling on the request (`request_children` → `children.full_name`), distinct from guessed "unnamed child" counts. */
  childNames?: string[];
  /** `served[].leg`: a one-way rider's companions are marked (REQ §13.178) — by `ride_leg` when known (REQ §13.179 d). */
  leg?: RideLeg;
  ride_leg?: RideLeg;
}

/** Only explicitly public request fields belong on the shared siddur. */
export function ridePublicDetails(
  entries: readonly RidePublicEntry[],
  options: {
    includeCompanions?: boolean;
    /** Directly `add_ride_passengers()`-added names (`v_board_rides.people`, `source: 'added'`,
     * REQ §13.85) — not tied to any one served request, so listed as one trailing line rather
     * than folded into a particular requester's companions. */
    addedNames?: readonly string[];
  } = {},
): string {
  const bothLegs = rideCarriesBothLegs(entries.map((entry) => entry.ride_leg ?? entry.leg));
  const lines = entries.flatMap((entry) => {
    const names = [
      ...(entry.companions ?? []).map((person) => person.name),
      ...(entry.guest_passenger_names ?? []),
      ...(entry.childNames ?? []),
    ].map((name) => name.trim()).filter(Boolean).map((name) => withLegMark(name, entry.ride_leg ?? entry.leg, bothLegs));
    const lines = [entry.ride_description?.trim(), names.length && options.includeCompanions !== false ? tv("ridePublicDetails.companions", { names: names.join(", ") }) : ""].filter(Boolean);
    if (lines.length && entries.length > 1 && entry.requester) lines.unshift(`${entry.requester}:`);
    return lines;
  });
  const added = (options.addedNames ?? []).map((name) => name?.trim()).filter((name): name is string => !!name);
  if (added.length && options.includeCompanions !== false) lines.push(tv("ridePublicDetails.companions", { names: added.join(", ") }));
  return lines.join("\n");
}
