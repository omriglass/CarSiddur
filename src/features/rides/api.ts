import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";
import { withSmallTrunkRetry } from "@/lib/smallTrunk";

import type { Database, Json } from "@/integrations/supabase/types";

import type { CarNeighbourRow } from "./carHandover";

/**
 * Shared ride-level pieces the `siddur` and `sadran` features both need (moved out of
 * `siddur/api.ts`/`sadran/servedOf.ts` — REFACTOR_BACKLOG "R8: break the siddur ⇄ sadran
 * import cycle"). The only file in the `rides` feature that calls `supabase.from`/`.rpc`.
 */
export type BoardRide = Database["public"]["Views"]["v_board_rides"]["Row"];

export type RideChange = Database["public"]["Tables"]["ride_change_requests"]["Row"] & {
  requester: { full_name: string } | null;
  parties: Database["public"]["Tables"]["ride_change_parties"]["Row"][];
};

export interface RideMove {
  rideId: string;
  carId: string;
  startsAt: string;
  endsAt: string;
  expectedVersion: number;
}

export async function claimRideDriver(rideId: string, expectedVersion: number): Promise<void> {
  await rpc("claim_ride_driver", { p_ride_id: rideId, p_expected_version: expectedVersion });
}

/** Public ride information only; does not modify scheduling, passengers or consent. */
export async function updateRidePublicNotes(rideId: string, expectedVersion: number, notes: string | null): Promise<void> {
  await rpc("update_ride_public_notes", { p_ride_id: rideId, p_expected_version: expectedVersion, p_notes: notes ?? "" });
}

export async function fetchRideChanges(departmentId?: string, weekStart?: string): Promise<RideChange[]> {
  let query = supabase.from("ride_change_requests")
    .select("*, requester:profiles!ride_change_requests_requester_id_fkey(full_name), parties:ride_change_parties(*)")
    .eq("status", "pending");
  if (departmentId) query = query.eq("department_id", departmentId);
  if (weekStart) query = query.eq("week_start", weekStart);
  const { data, error } = await query.order("created_at");
  if (error) throw toAppError(error);
  return (data ?? []) as RideChange[];
}

export async function requestRideChange(move: RideMove): Promise<string> {
  // REQ §13.111 (a): the driver accepts a car without a large trunk for their own large-luggage request ("לשבץ בכל זאת?").
  return withSmallTrunkRetry((allowSmallTrunk) => rpc("request_ride_change", {
    p_ride_id: move.rideId, p_car_id: move.carId,
    p_starts_at: move.startsAt, p_ends_at: move.endsAt, p_expected_version: move.expectedVersion,
    p_allow_small_trunk: allowSmallTrunk,
  }));
}

export async function respondRideChange(changeId: string, accept: boolean): Promise<void> {
  await rpc("respond_ride_change", { p_change_id: changeId, p_accept: accept });
}

export async function cancelRideChange(changeId: string): Promise<void> {
  await rpc("cancel_ride_change", { p_change_id: changeId });
}

/**
 * Same row shape as `features/sadran/api.ts`'s `RidePassengerInput` (the Sadran board's
 * `set_ride_passengers()` *replace* editor) — kept as a separate local type rather than a
 * cross-feature import so each feature's `api.ts` stays the only place it calls `.rpc()` for
 * its own inputs.
 */
export interface RidePassengerInput {
  person_id?: string;
  child_id?: string;
  display_name: string;
  seat_kind: "adult" | "child_seat" | "booster";
}

/** Appends named passengers to a ride's existing list (never replaces it); duplicates already on the ride or already served are silently skipped by the RPC. */
export async function addRidePassengers(rideId: string, expectedVersion: number, passengers: RidePassengerInput[]): Promise<void> {
  await rpc("add_ride_passengers", { p_ride_id: rideId, p_expected_version: expectedVersion, p_passengers: passengers as unknown as Json });
}

/**
 * Removes exactly one person from a ride's unified `v_board_rides.people` list, addressed by
 * that entry's `key` — any of `driver:`/`req:`/`comp:`/`child:`/`guest:`/`added:`, though the
 * driver's own entry always has `removable: false` and is never offered a remove control
 * (`RidePassengersList`/`ridePeople.ts`'s `canRemoveRidePerson`). 20260914190000_unified_
 * ride_people.sql replaced the narrower `remove_ride_passenger(uuid, int)`, which only took a
 * `ride_passengers.id`, with this key-based, ride-scoped RPC open to any approved department
 * member on a published/live week (or a Sadran/admin who manages it).
 */
export async function removeRidePerson(rideId: string, expectedVersion: number, key: string): Promise<void> {
  await rpc("remove_ride_person", { p_ride_id: rideId, p_expected_version: expectedVersion, p_key: key });
}

/**
 * REQ §13.108 f: the ride before/after each given ride on its car (`v_ride_car_neighbours`, security_invoker —
 * a member only gets rows for rides RLS lets them see). One round trip for any number of rides.
 */
export async function fetchCarNeighbours(rideIds: readonly string[]): Promise<CarNeighbourRow[]> {
  if (rideIds.length === 0) return [];
  const { data, error } = await supabase.from("v_ride_car_neighbours").select("*").in("ride_id", [...rideIds]);
  if (error) throw toAppError(error);
  return data ?? [];
}

/**
 * What the week-grid Excel sheet needs beyond the rides (both exports, Sadran + archive):
 * every car of the department with its type (a private car is listed only when it has a ride),
 * the department home place (ride-label direction) and the board's first visible time.
 * `cars`, `departments` and `department_settings` are readable by any approved member.
 */
export interface ExportLayoutData {
  cars: { id: string; name: string; type: string | null; status?: string | null }[];
  homeDestinationId: string | null;
  boardStartTime: string | null;
}
export async function fetchExportLayout(departmentId: string): Promise<ExportLayoutData> {
  const [cars, department, settings] = await Promise.all([
    supabase.from("cars").select("id, name, type, status").eq("department_id", departmentId).order("name"),
    supabase.from("departments").select("home_destination_id").eq("id", departmentId).maybeSingle(),
    supabase.from("department_settings").select("board_start_time").eq("department_id", departmentId).maybeSingle(),
  ]);
  if (cars.error) throw toAppError(cars.error);
  if (department.error) throw toAppError(department.error);
  if (settings.error) throw toAppError(settings.error);
  return { cars: cars.data ?? [], homeDestinationId: department.data?.home_destination_id ?? null, boardStartTime: settings.data?.board_start_time ?? null };
}
