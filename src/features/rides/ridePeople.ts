// src/features/siddur/ridePeople.ts
//
// The unified ride-people model (REQ §13.85, DATA_MODEL.md "`v_board_rides.people`" —
// `supabase/migrations/20260914190000_unified_ride_people.sql`): one list per ride, driver
// first, covering every source a person can be on a ride through — the driver, each served
// request's non-driver requester, its companions/children/guest names, and every directly
// `add_ride_passengers()`-added row. Owner decision 2026-09-14: "one passenger list per ride,
// whatever the source; people added directly are indistinguishable at a glance from
// request-filed ones." This module is the one place that reads/derives from `people` — every
// screen (siddur `RideDetailSheet`, board `RideSheet`, Home's upcoming-ride cards, the Excel
// export) calls into it instead of re-deriving names/seat counts from `served`/`passengers`
// piecemeal.
//
// Pure, no React/Supabase — unit tested directly (`ridePeople.test.ts`).

import { z } from "zod";

import { rideCarriesBothLegs, withLegMark, type LegName, type RideLeg } from "@/lib/rideLegMark";

import type { BoardRide } from "./api";

export const ridePersonSourceSchema = z.enum(["driver", "requester", "companion", "child", "guest", "added"]);
export type RidePersonSource = z.infer<typeof ridePersonSourceSchema>;

export const ridePersonSeatKindSchema = z.enum(["adult", "child_seat", "booster"]);
export type RidePersonSeatKind = z.infer<typeof ridePersonSeatKindSchema>;

/** One `v_board_rides.people[]` entry (DATA_MODEL.md's `v_board_rides.people jsonb` contract). */
export const ridePersonSchema = z.object({
  key: z.string(),
  source: ridePersonSourceSchema,
  request_id: z.string().nullable(),
  ride_passenger_id: z.string().nullable(),
  person_id: z.string().nullable(),
  child_id: z.string().nullable(),
  display_name: z.string(),
  seat_kind: ridePersonSeatKindSchema,
  added_by: z.string().nullable(),
  /** `false` only for the `driver` entry — the RPCs still re-check authorization/role regardless. */
  removable: z.boolean(),
  /** The part of the ride the person rides: a "+ נוסעים" row's own `ride_passengers.leg`, a request row's leg on this ride (REQ §13.179 d). */
  leg: z.enum(["out", "return", "both"]).nullish(),
});

export type RidePerson = z.infer<typeof ridePersonSchema>;

/**
 * Reads `v_board_rides.people` (a jsonb array, already ordered driver first, then
 * `display_name`, then `key` — DATA_MODEL.md) into typed rows. Invalid/malformed entries are
 * dropped rather than thrown (defensive against a stale cached row mid-migration), the same
 * permissive spirit `servedOf()`/`namedPassengersOf()` (`features/sadran/applySolve.ts`) use
 * for their own jsonb columns.
 */
export function peopleOf(ride: Pick<BoardRide, "people">): RidePerson[] {
  const raw = ride.people;
  if (!Array.isArray(raw)) return [];
  const people: RidePerson[] = [];
  // R2B15: one row per `key` (a volunteer driver after `set_ride_driver` can arrive twice).
  // R22B4 (CM1): one row per person too - on a chained ride the same person is on both trips (the driver, again as the
  // second trip's requester); the first row (the driver's) stands for them, as one person counts once (REQ item 260).
  const seen = new Set<string>();
  for (const entry of raw) {
    const parsed = ridePersonSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.key)) continue;
    const person = personKey(parsed.data);
    if (person && seen.has(person)) continue;
    seen.add(parsed.data.key);
    if (person) seen.add(person);
    people.push(parsed.data);
  }
  return people;
}

/** The person behind a row (a member or a named child), for "one person counts once"; unnamed guests have none. */
function personKey(person: RidePerson): string | null {
  if (person.source === "child") return person.child_id ? `child:${person.child_id}` : null;
  if (!person.person_id) return null;
  return person.source === "driver" || person.source === "requester" || person.source === "companion" ? `person:${person.person_id}` : null;
}

/** Display names of everyone on the ride, in list order; `excludeDriver` drops the driver's own name. */
export function peopleNames(people: readonly RidePerson[], options: { excludeDriver?: boolean } = {}): string[] {
  return people
    .filter((person) => !(options.excludeDriver && person.source === "driver"))
    .map((person) => person.display_name.trim())
    .filter((name) => name.length > 0);
}

/**
 * REQ §13.178: the person's name, with "(הלוך)"/"(חזור)" when they ride one way only on a ride that carries
 * both directions. Request rows take their request's leg from `served`; "+ נוסעים" rows carry their own.
 */
export function legMarkedName(person: RidePerson, served: readonly LegEntry[]): string {
  const entry = person.request_id ? served.find((candidate) => candidate.request_id === person.request_id) : undefined;
  const leg = person.leg ?? entry?.ride_leg ?? entry?.leg;
  return withLegMark(person.display_name.trim(), leg, rideCarriesBothLegs(served.map((candidate) => candidate.ride_leg ?? candidate.leg)));
}

type LegEntry = { request_id: string | null; leg: RideLeg; ride_leg?: RideLeg };

/** "+ נוסעים" names (`source: 'added'`) with the leg each rides — the `addedNames` option of the passenger summaries. */
export function addedPeopleNames(ride: Pick<BoardRide, "people" | "served">, served: readonly LegEntry[]): LegName[] {
  return peopleOf(ride).filter((person) => person.source === "added").map((person) => ({ name: person.display_name.trim(), leg: personLeg(person, served) }));
}

function personLeg(person: RidePerson, served: readonly LegEntry[]): RideLeg | undefined {
  const entry = person.request_id ? served.find((candidate) => candidate.request_id === person.request_id) : undefined;
  return person.leg ?? entry?.ride_leg ?? entry?.leg;
}

export interface SeatLoad {
  adults: number;
  childSeats: number;
  boosters: number;
}

/** Seat load of the whole `people` list (or everyone but the driver), grouped by `seat_kind`. */
export function peopleSeatLoad(people: readonly RidePerson[], options: { excludeDriver?: boolean } = {}): SeatLoad {
  const load: SeatLoad = { adults: 0, childSeats: 0, boosters: 0 };
  for (const person of people) {
    if (options.excludeDriver && person.source === "driver") continue;
    if (person.seat_kind === "adult") load.adults += 1;
    else if (person.seat_kind === "child_seat") load.childSeats += 1;
    else load.boosters += 1;
  }
  return load;
}

export interface CarSeatCapacity {
  adults: number;
  child_seats: number;
  boosters: number;
}

/**
 * Seats still free on `car` given everyone already on `people` (the driver included — they
 * occupy a real adult seat, CLAUDE.md consistency decision 11 "the host's driver counts
 * once"). Mirrors the adult-capacity approximation `joinable_rides_for_request()` uses
 * server-side (car's adult capacity minus adults already served), extended here to the
 * child-seat/booster dimensions since the unified `people` list now carries a real
 * `seat_kind` per row. Never negative.
 */
export function freeSeats(people: readonly RidePerson[], car: CarSeatCapacity): number {
  const load = peopleSeatLoad(people);
  return Math.max(0, car.adults - load.adults);
}

/**
 * Whether the current viewer may remove this `people[]` entry right now — the entry's own
 * `removable` flag (`false` only for the driver) plus the two conditions that gate
 * `remove_ride_person()` itself (DATA_MODEL.md): the caller must satisfy the ride's
 * add/remove authorization (any department member once the week is public, or a Sadran who
 * manages the week — the same gate `add_ride_passengers()` uses, so callers reuse whatever
 * boolean already gates showing the "+ נוסעים" button), and the ride must not be cancelled.
 * The RPC re-checks both regardless; this only decides whether to render the × at all.
 */
export function canRemoveRidePerson(
  person: Pick<RidePerson, "removable">,
  options: { canManagePeople: boolean; rideCancelled: boolean },
): boolean {
  return person.removable && options.canManagePeople && !options.rideCancelled;
}

/**
 * The `key` of the viewer's own non-driver row on the ride (REQ §13.128 "הסר אותי"), or `null` when
 * the viewer is not on the ride or is its driver (the driver cancels the ride instead).
 */
export function myRidePersonKey(ride: Pick<BoardRide, "people" | "driver_id">, profileId: string | null | undefined): string | null {
  if (!profileId || ride.driver_id === profileId) return null;
  const people = peopleOf(ride);
  if (people.some((person) => person.person_id === profileId && person.source === "driver")) return null;
  return people.find((person) => person.person_id === profileId && person.source !== "driver")?.key ?? null;
}

/** First names, unless two of them share one (then the full names). */
export function shortNames(names: readonly string[]): string[] {
  const first = (name: string) => name.split(/\s+/)[0] ?? name;
  const count = new Map<string, number>();
  for (const name of new Set(names)) count.set(first(name), (count.get(first(name)) ?? 0) + 1);
  return names.map((name) => (count.get(first(name)) === 1 ? first(name) : name));
}

/** RP1 (owner 2026-11-21): everyone on the ride for its title, driver first - "חבר, נגה וענבר לבנימינה". */
export function riderShortNames(ride: Pick<BoardRide, "people">): string[] {
  return shortNames(peopleOf(ride).map((person) => person.display_name.trim()).filter(Boolean));
}
