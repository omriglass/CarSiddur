import { tv } from "@/i18n/he";
import { legLines, namesByLeg, rideCarriesBothLegs, type LegName, type RideLeg } from "./rideLegMark";
import type { RidePublicEntry } from "./ridePublicDetails";

interface PassengerEntry extends RidePublicEntry {
  request_id?: string | null;
  role?: "driver" | "passenger";
  /** `served[].leg`: a one-way rider's names are marked (REQ §13.178) — by `ride_leg` when known (REQ §13.179 d). */
  leg?: RideLeg;
  ride_leg?: RideLeg;
  adults: number;
  child_seats: number;
  boosters: number;
}

/** Named people occupy adult places first, matching the request form's seat accounting. */
export function ridePassengerSummary(
  entries: readonly PassengerEntry[],
  driverName?: string | null,
  options: { addedNames?: readonly (string | LegName)[] } = {},
): string {
  const { names, adults, children, byLeg } = ridePassengerParts(entries, driverName, options);
  // RP1: someone rides one way only — "הלוך: …" / "חזור: …", each leg with its own people.
  if (byLeg) {
    return legLines(
      { out: [...byLeg.out.names, ...unnamedParts(byLeg.out.adults, byLeg.out.children)], ret: [...byLeg.ret.names, ...unnamedParts(byLeg.ret.adults, byLeg.ret.children)] },
      joinParts,
    ).join("\n");
  }
  const parts = [...names, ...unnamedParts(adults, children)];
  if (!parts.length) return "";
  return tv("ridePublicDetails.passengers", { summary: joinParts(parts) });
}

export function unnamedParts(adults: number, children: number): string[] {
  return [
    ...(adults ? [tv(adults === 1 ? "ridePublicDetails.unnamedAdult" : "ridePublicDetails.unnamedAdults", { count: String(adults) })] : []),
    ...(children ? [tv(children === 1 ? "ridePublicDetails.unnamedChild" : "ridePublicDetails.unnamedChildren", { count: String(children) })] : []),
  ];
}

/** "א, ב וג". */
export function joinParts(parts: readonly string[]): string {
  return parts.length === 1 ? parts[0]! : tv("ridePublicDetails.joinPassengers", { names: parts.slice(0, -1).join(", "), last: parts.at(-1)! });
}

export interface LegPeople { names: string[]; adults: number; children: number }

/** Named people plus the counts of unnamed adults/children (shared by the summary text and the Excel grid's "who" wording). */
export function ridePassengerParts(
  entries: readonly PassengerEntry[],
  driverName?: string | null,
  options: {
    /**
     * Directly `add_ride_passengers()`-added names (`v_board_rides.people`, `source: 'added'`,
     * REQ §13.85) — these have no backing request, so unlike `entries` above they carry no
     * `adults`/`child_seats` count to reconcile against; just named people to list alongside
     * everyone else.
     */
    addedNames?: readonly (string | LegName)[];
  } = {},
): { names: string[]; adults: number; children: number; byLeg: { out: LegPeople; ret: LegPeople } | null } {
  const named: LegName[] = [];
  let adults = 0;
  let children = 0;
  const unnamedByLeg: { leg: RideLeg | undefined; adults: number; children: number }[] = [];
  const seenRequests = new Set<string>();
  const bothLegs = rideCarriesBothLegs(entries.map((entry) => entry.ride_leg ?? entry.leg));
  if (driverName?.trim() && !entries.some((entry) => entry.role === "driver")) named.push({ name: driverName.trim(), leg: "both" });
  for (const entry of entries) {
    if (entry.request_id && seenRequests.has(entry.request_id)) continue;
    if (entry.request_id) seenRequests.add(entry.request_id);
    const leg = entry.ride_leg ?? entry.leg;
    const people = [entry.requester || (entry.role === "driver" ? driverName : null), ...(entry.companions ?? []).map((person) => person.name), ...(entry.guest_passenger_names ?? [])]
      .map((name) => name?.trim()).filter((name): name is string => !!name);
    /** Explicitly named children (`request_children` → `children.full_name`) are known-for-sure children, unlike `named` above (adults/guests, whose overflow past `adults` is only *guessed* to fill a child seat). */
    const namedChildren = (entry.childNames ?? []).map((name) => name?.trim()).filter((name): name is string => !!name);
    named.push(...[...people, ...namedChildren].map((name) => ({ name, leg })));
    // R22B6: a named child past the child seats/boosters sits in an adult seat (counted in `adults`), not an extra adult.
    const seatSlots = Math.max(0, entry.child_seats + entry.boosters - Math.max(0, people.length - entry.adults));
    const childrenInAdultSeats = Math.max(0, namedChildren.length - seatSlots);
    const entryAdults = Math.max(0, entry.adults - people.length - childrenInAdultSeats);
    const entryChildren = Math.max(0, seatSlots - namedChildren.length);
    adults += entryAdults;
    children += entryChildren;
    unnamedByLeg.push({ leg, adults: entryAdults, children: entryChildren });
  }
  for (const added of options.addedNames ?? []) {
    const item = typeof added === "string" ? { name: added, leg: undefined } : added;
    const name = item.name?.trim();
    if (name) named.push({ name, leg: item.leg });
  }
  const split = namesByLeg(named, bothLegs);
  const byLeg = split ? {
    out: legPeople(split.out, unnamedByLeg.filter((u) => u.leg !== "return")),
    ret: legPeople(split.ret, unnamedByLeg.filter((u) => u.leg !== "out")),
  } : null;
  return { names: named.map((item) => item.name), adults, children, byLeg };
}

function legPeople(names: string[], unnamed: readonly { adults: number; children: number }[]): LegPeople {
  return { names, adults: unnamed.reduce((n, u) => n + u.adults, 0), children: unnamed.reduce((n, u) => n + u.children, 0) };
}
