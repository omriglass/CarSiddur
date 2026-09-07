import { tv } from "@/i18n/he";

export interface RidePublicEntry {
  requester?: string | null;
  ride_description?: string | null;
  guest_passenger_names?: string[];
  companions?: { profile_id: string; name: string }[];
}

/** Only explicitly public request fields belong on the shared siddur. */
export function ridePublicDetails(entries: readonly RidePublicEntry[], options: { includeCompanions?: boolean } = {}): string {
  return entries.flatMap((entry) => {
    const names = [
      ...(entry.companions ?? []).map((person) => person.name),
      ...(entry.guest_passenger_names ?? []),
    ].map((name) => name.trim()).filter(Boolean);
    const lines = [entry.ride_description?.trim(), names.length && options.includeCompanions !== false ? tv("ridePublicDetails.companions", { names: names.join(", ") }) : ""].filter(Boolean);
    if (lines.length && entries.length > 1 && entry.requester) lines.unshift(`${entry.requester}:`);
    return lines;
  }).join("\n");
}
