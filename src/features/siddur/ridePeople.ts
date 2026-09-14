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
  for (const entry of raw) {
    const parsed = ridePersonSchema.safeParse(entry);
    if (parsed.success) people.push(parsed.data);
  }
  return people;
}

/** Display names of everyone on the ride, in list order; `excludeDriver` drops the driver's own name. */
export function peopleNames(people: readonly RidePerson[], options: { excludeDriver?: boolean } = {}): string[] {
  return people
    .filter((person) => !(options.excludeDriver && person.source === "driver"))
    .map((person) => person.display_name.trim())
    .filter((name) => name.length > 0);
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
