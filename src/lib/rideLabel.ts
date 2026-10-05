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
import { formatTime } from "@/lib/time";

export interface RideLabelServedEntry {
  role: "driver" | "passenger";
  /** `v_board_rides.served[].requester` — the request's `profiles.full_name`. */
  requester?: string | null;
  /** `v_board_rides.served[].destination` — `coalesce(destinations.name, requests.destination_text)`. */
  destination?: string | null;
  leg?: "out" | "return" | "both";
  car_mode?: "keep" | "relay" | "passenger" | "chauffeur";
  /** REQUIREMENTS §13.93 (`v_board_rides.served[].origin_id/origin_name`): the request's own
   *  origin — distinct from the ride's own `originId` (where the *car* starts) whenever this
   *  entry was merged onto a host with a different origin, or the ride's origin is mid-chain. */
  origin_id?: string | null;
  origin_name?: string | null;
  /** REQUIREMENTS §13.93 `trip_type`: decides the driver-label wording (plain one-way "parked"
   *  vs a הקפצה relay pair's "leave"/"wait" phrasing below). */
  trip_type?: "round_trip" | "one_way" | "drop_off" | null;
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
  /**
   * REQ §89 (owner 2026-09-15): an automatic missing-driver relocation ride (`rides.
   * auto_relocation`, DB-inserted to heal the car chain, `served` empty until someone
   * volunteers) — shown as a fixed label rather than the usual driver/passenger names, on
   * both the board and the siddur (this function is shared between the two).
   */
  autoRelocation?: boolean;
  /** The ride's own departure time (ISO) — REQUIREMENTS §13.93 "Display": a chauffeur pickup
   *  leg shows "(יציאה {{time}})", the whole ride's own start. */
  startsAt?: string;
  /** `v_board_rides.relay_partner` — the paired relay leg (out ↔ return) on the same car: its
   *  ride id, driver (or first requester) name and time. REQUIREMENTS §13.93 "Display": a
   *  relay pair's leave/wait label names the partner and the time instead of just the place. */
  relayPartner?: { ride_id: string; name: string; at: string } | null;
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

/**
 * The designated driver may have no request of their own (a volunteer). REQUIREMENTS §13.93
 * "Display": a chauffeur ride carrying exactly one passenger group gets the precise wording
 * ("X מסיע/ה את Y לחריש וחוזר/ת" drop-off, "X אוסף/ת את Y מחריש (יציאה 15:20)" pickup); a ride
 * that ended up carrying several distinct groups (rare — a chauffeur ride is normally a single
 * lone leg) falls back to the older combined phrasing rather than repeating the driver's name
 * once per group.
 */
export function chauffeurRideLabel(driverName: string | null, passengers: readonly RideLabelServedEntry[], startsAt?: string, carLocationId?: string): string {
  const driver = driverName?.trim() ? firstName(driverName) : "_____";
  const groups = new Map<string, { destination: string; returning: boolean; names: string[] }>();
  for (const passenger of passengers) {
    // A pickup is a legacy return leg (fetch from its destination), or — REQ §13.93 "pick me up
    // from Harish" — an out leg whose own origin is not where the car is (`carLocationId`, the
    // chauffeur ride's origin): the driver fetches the passenger at that origin.
    const pickupFromOrigin = passenger.leg !== "return" && !!carLocationId && !!passenger.origin_id
      && passenger.origin_id !== carLocationId;
    const destination = pickupFromOrigin ? (passenger.origin_name ?? "") : (passenger.destination ?? "");
    const returning = passenger.leg === "return" || pickupFromOrigin;
    const key = JSON.stringify([destination, returning]);
    const group = groups.get(key) ?? { destination, returning, names: [] };
    if (passenger.requester) group.names.push(firstName(passenger.requester));
    groups.set(key, group);
  }
  const groupList = [...groups.values()];
  if (groupList.length === 1) {
    const [group] = groupList as [{ destination: string; returning: boolean; names: string[] }];
    const name = hebrewList(group.names);
    return group.returning
      ? tv("rideCoordination.chauffeurPickup", { driver, name, place: group.destination, time: startsAt ? formatTime(new Date(startsAt)) : "" })
      : tv("rideCoordination.chauffeurDropoff", { driver, name, place: group.destination });
  }
  const routes = groupList.map((group) => tv(
    group.returning ? "rideCoordination.passengerFrom" : "rideCoordination.passengerTo",
    { name: hebrewList(group.names), destination: group.destination },
  ));
  return tv("rideCoordination.chauffeurLabel", { driver, passengers: hebrewList(routes) });
}

/**
 * The direction prefix ("ל"/"מ") and the real place name — shared by
 * `rideBlockLabel` (board grid) and `resolveRideRealDestination` (board
 * list-mode `RideCard`s, which show origin/destination as two separate
 * fields rather than one composed string). `originLabel`, when set
 * (REQUIREMENTS §13.93 "Display"), is the served request's own origin —
 * shown as a "מ<origin>" prefix whenever it isn't the department home.
 */
function resolveDirection(input: RideLabelInput): { kind: "to" | "from"; place: string; originLabel?: string } {
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
  // Round trip (origin === destination): the real destination only exists on the served
  // requests. The ride's shared origin/destination is normally the department home, but
  // REQUIREMENTS §13.93 allows a round trip to start at a member's own non-home default
  // origin instead — surfaced here as a "מ<origin>" prefix.
  const driver = input.served.find((s) => s.role === "driver");
  const passenger = input.served.find((s) => s.role === "passenger" && s.destination);
  const primary = driver ?? passenger;
  const originLabel = primary?.origin_name && primary.origin_id && primary.origin_id !== input.homeDestinationId
    ? primary.origin_name
    : undefined;
  return { kind: "to", place: driver?.destination ?? passenger?.destination ?? input.destinationName, originLabel };
}

/**
 * "<driver> ו<passenger1> ו<passenger2>… ל<destination>" (round trip /
 * one-way-to), or "…מ<origin>" for a one-way-from leg (the leg's meaningful
 * place is where it started, since it *ends* at home). Falls back to the
 * ride's own destination name if no served request carries one (shouldn't
 * happen for a real ride, but keeps this total).
 */
export function rideBlockLabel(input: RideLabelInput): string {
  if (input.autoRelocation) return he.sadranBoard.autoRelocation;
  const driver = input.served.find((s) => s.role === "driver");
  const passengers = input.served.filter((s) => s.role === "passenger");

  // REQUIREMENTS §13.93 "Display": a lone relay leg (one served request, no merge) tells the
  // Sadran/member what happens to the *car*, not just who travels — a plain הלוך בלבד leaves it
  // parked with nobody designated to bring it back, while a הקפצה relay pair's own leg either
  // leaves the car for a later trip to pick up or is itself that later pickup. The matching
  // leg's own name/time comes from `v_board_rides.relay_partner` (the paired ride, same car,
  // same day); falls back to the place-only wording when it isn't known yet (not paired, or an
  // older `v_board_rides` row before this field existed).
  if (input.served.length === 1 && driver?.car_mode === "relay") {
    if (driver.trip_type === "one_way") {
      return tv("rideCoordination.oneWayParked", {
        name: driver.requester ? firstName(driver.requester) : "",
        place: driver.leg === "return" ? input.originName : input.destinationName,
      });
    }
    if (driver.trip_type === "drop_off") {
      // QB24: a partner who is the same person as this leg's own requester is not named ("leaves the car for himself").
      const partner = input.relayPartner && driver.requester && firstName(input.relayPartner.name) === firstName(driver.requester) ? undefined : input.relayPartner;
      if (driver.leg === "return") {
        return partner
          ? tv("rideCoordination.relayWaitFrom", { place: input.originName, name: firstName(partner.name), time: formatTime(new Date(partner.at)) })
          : tv("rideCoordination.relayWait", { place: input.originName });
      }
      return partner
        ? tv("rideCoordination.relayLeaveFor", { place: input.destinationName, name: firstName(partner.name), time: formatTime(new Date(partner.at)) })
        : tv("rideCoordination.relayLeave", { place: input.destinationName });
    }
  }

  if (passengers.length && (input.isChauffeur || input.needsDriver || passengers.some((s) => s.car_mode === "chauffeur"))) {
    const direction = resolveDirection(input);
    const label = chauffeurRideLabel(input.needsDriver ? null : input.driverName ?? driver?.requester ?? null, passengers.map((passenger) => ({
      ...passenger,
      destination: passenger.destination ?? direction.place,
      leg: passenger.leg ?? (direction.kind === "from" ? "return" : "out"),
    })), input.startsAt, input.originId);
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

  const { kind, place, originLabel } = resolveDirection(input);
  const prefix = he.rideLabel[kind];
  const originPrefix = originLabel ? `${he.rideLabel.from}${originLabel} ` : "";
  return who ? `${who} ${originPrefix}${prefix}${place}` : `${originPrefix}${prefix}${place}`;
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
