// src/lib/rideLabel.ts
//
// Ride block/card label — shared by the Sadran board *and* the member siddur
// (day list, wide-screen grid, RideDetailSheet, Home's upcoming-rides card;
// UX_FLOWS.md §4.2/§20). Originally board-only (owner bug report #3: block
// labels read "עומרי ועומר לתל אביב", not the department's own name), then
// moved here (from `src/features/sadran/board/rideLabel.ts`, which now
// re-exports this module so existing board imports keep working) once the
// same bug was found on the member-facing siddur/Home — those screens
// rendered `ride.destination_name` directly too, which is correct for a
// one-way ride (origin/destination genuinely differ) but wrong for a round
// trip, which DATA_MODEL.md consistency decision #14 stores as a *single*
// ride row with `origin_id === destination_id === the department's home
// location` (`assert_car_chain`'s own check in `20260907090800_rides.sql`).
// For a round trip the ride's own `destination_id` is therefore always home
// ("נבו"), and the real travel destination only exists on the requests it
// serves (`v_board_rides.served[].destination`, DATA_MODEL.md §7) — visible
// to any approved member per REQUIREMENTS §10 (`profiles_select`/
// `requests_select`/`rides_select` RLS all allow reading a public week's
// served requests and requester names, not just the Sadran).
//
// Pure/no React, no Supabase — unit tested directly (rideLabel.test.ts).

import { he, tv } from "@/i18n/he";

export interface RideLabelServedEntry {
  role: "driver" | "passenger";
  /** `v_board_rides.served[].requester` — the request's `profiles.full_name`. */
  requester?: string | null;
  /** `v_board_rides.served[].destination` — `coalesce(destinations.name, requests.destination_text)`. */
  destination?: string | null;
  leg?: "out" | "return" | "both";
  car_mode?: "keep" | "relay" | "passenger" | "chauffeur";
}

export interface RideLabelInput {
  originId: string;
  destinationId: string;
  originName: string;
  destinationName: string;
  homeDestinationId: string;
  served: readonly RideLabelServedEntry[];
  driverName?: string | null;
  isChauffeur?: boolean;
  needsDriver?: boolean;
}

function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

/** Hebrew-conjunction list: "א", "א וב", "א, ב וג". */
function hebrewList(names: readonly string[]): string {
  const clean = names.filter((n) => n.length > 0);
  if (clean.length === 0) return "";
  const last = clean[clean.length - 1] as string;
  if (clean.length === 1) return last;
  return `${clean.slice(0, -1).join(", ")} ${he.rideLabel.and}${last}`;
}

/** The designated driver may have no request of their own (a volunteer). */
export function chauffeurRideLabel(driverName: string | null, passengers: readonly RideLabelServedEntry[]): string {
  const groups = new Map<string, { destination: string; returning: boolean; names: string[] }>();
  for (const passenger of passengers) {
    const destination = passenger.destination ?? "";
    const returning = passenger.leg === "return";
    const key = JSON.stringify([destination, returning]);
    const group = groups.get(key) ?? { destination, returning, names: [] };
    if (passenger.requester) group.names.push(firstName(passenger.requester));
    groups.set(key, group);
  }
  const routes = [...groups.values()].map((group) => tv(
    group.returning ? "rideCoordination.passengerFrom" : "rideCoordination.passengerTo",
    { name: hebrewList(group.names), destination: group.destination },
  ));
  return tv("rideCoordination.chauffeurLabel", {
    driver: driverName?.trim() ? firstName(driverName) : "_____",
    passengers: hebrewList(routes),
  });
}

/**
 * The direction prefix ("ל"/"מ") and the real place name — shared by
 * `rideBlockLabel` (board grid) and `resolveRideRealDestination` (board
 * list-mode `RideCard`s, which show origin/destination as two separate
 * fields rather than one composed string).
 */
function resolveDirection(input: RideLabelInput): { kind: "to" | "from"; place: string } {
  const isHomeOrigin = input.originId === input.homeDestinationId;
  const isHomeDestination = input.destinationId === input.homeDestinationId;

  if (isHomeOrigin && !isHomeDestination) {
    // one-way-to: leaving home for the destination.
    return { kind: "to", place: input.destinationName };
  }
  if (!isHomeOrigin && isHomeDestination) {
    // one-way-from: arriving home from wherever it started.
    return { kind: "from", place: input.originName };
  }
  // Round trip (origin === destination, normally home): the real
  // destination only exists on the served requests.
  const driver = input.served.find((s) => s.role === "driver");
  const passenger = input.served.find((s) => s.role === "passenger" && s.destination);
  return { kind: "to", place: driver?.destination ?? passenger?.destination ?? input.destinationName };
}

/**
 * "<driver> ו<passenger1> ו<passenger2>… ל<destination>" (round trip /
 * one-way-to), or "…מ<origin>" for a one-way-from leg (the leg's meaningful
 * place is where it started, since it *ends* at home). Falls back to the
 * ride's own destination name if no served request carries one (shouldn't
 * happen for a real ride, but keeps this total).
 */
export function rideBlockLabel(input: RideLabelInput): string {
  const driver = input.served.find((s) => s.role === "driver");
  const passengers = input.served.filter((s) => s.role === "passenger");
  if (passengers.length && (input.isChauffeur || input.needsDriver || passengers.some((s) => s.car_mode === "chauffeur"))) {
    const direction = resolveDirection(input);
    const label = chauffeurRideLabel(input.needsDriver ? null : input.driverName ?? driver?.requester ?? null, passengers.map((passenger) => ({
      ...passenger,
      destination: passenger.destination ?? direction.place,
      leg: passenger.leg ?? (direction.kind === "from" ? "return" : "out"),
    })));
    // A merged passenger leg must not hide the host's separate destination.
    if (driver?.destination && !passengers.some((passenger) => passenger.destination === driver.destination)) {
      return `${label} · ${tv(driver.leg === "return" ? "rideCoordination.passengerFrom" : "rideCoordination.passengerTo", {
        name: driver.requester ? firstName(driver.requester) : "", destination: driver.destination,
      })}`;
    }
    return label;
  }
  const destinations = new Set(input.served.map((s) => s.destination).filter(Boolean));
  if (destinations.size > 1) {
    return [driver, ...passengers].filter((s): s is RideLabelServedEntry => !!s).map((s) =>
      tv(s.leg === "return" ? "rideCoordination.passengerFrom" : "rideCoordination.passengerTo", {
        name: s.requester ? firstName(s.requester) : "", destination: s.destination ?? "",
      }),
    ).join(" · ");
  }
  const names = [driver, ...passengers]
    .map((s) => (s?.requester ? firstName(s.requester) : null))
    .filter((n): n is string => !!n);
  const who = hebrewList(names);

  const { kind, place } = resolveDirection(input);
  const prefix = he.rideLabel[kind];
  return who ? `${who} ${prefix}${place}` : `${prefix}${place}`;
}

/**
 * Just the real destination place name (no driver/passenger names, no
 * ל/מ prefix) — for `RideCard`'s separate origin/destination fields
 * (`BoardListMode`, the board's phone fallback) instead of the ride's own
 * `destination_name`, which is always the home location for a round trip.
 */
export function resolveRideRealDestination(input: RideLabelInput): string {
  const destinations = [...new Set(input.served.map((s) => s.destination).filter((d): d is string => !!d))];
  if (destinations.length > 1) return destinations.join(" · ");
  return resolveDirection(input).place;
}
