import { tv } from "@/i18n/he";
import type { RidePublicEntry } from "./ridePublicDetails";

interface PassengerEntry extends RidePublicEntry {
  request_id?: string | null;
  role?: "driver" | "passenger";
  adults: number;
  child_seats: number;
  boosters: number;
}

/** Named people occupy adult places first, matching the request form's seat accounting. */
export function ridePassengerSummary(entries: readonly PassengerEntry[], driverName?: string | null): string {
  const names: string[] = [];
  let adults = 0;
  let children = 0;
  const seenRequests = new Set<string>();
  if (driverName?.trim() && !entries.some((entry) => entry.role === "driver")) names.push(driverName.trim());
  for (const entry of entries) {
    if (entry.request_id && seenRequests.has(entry.request_id)) continue;
    if (entry.request_id) seenRequests.add(entry.request_id);
    const named = [entry.requester || (entry.role === "driver" ? driverName : null), ...(entry.companions ?? []).map((person) => person.name), ...(entry.guest_passenger_names ?? [])]
      .map((name) => name?.trim()).filter((name): name is string => !!name);
    names.push(...named);
    adults += Math.max(0, entry.adults - named.length);
    children += Math.max(0, entry.child_seats + entry.boosters - Math.max(0, named.length - entry.adults));
  }
  const parts = [...names];
  if (adults) parts.push(tv(adults === 1 ? "ridePublicDetails.unnamedAdult" : "ridePublicDetails.unnamedAdults", { count: String(adults) }));
  if (children) parts.push(tv(children === 1 ? "ridePublicDetails.unnamedChild" : "ridePublicDetails.unnamedChildren", { count: String(children) }));
  if (!parts.length) return "";
  const summary = parts.length === 1 ? parts[0]! : tv("ridePublicDetails.joinPassengers", { names: parts.slice(0, -1).join(", "), last: parts.at(-1)! });
  return tv("ridePublicDetails.passengers", { summary });
}
