import { supabase } from "@/integrations/supabase/client";
import { AppError, rpc, toAppError } from "@/lib/rpc";
import { isMyDraftRide } from "@/features/rides/myRides";
import { siddurCarName } from "@/lib/siddurCarName";
import { ensureOncePerSession } from "./ensureWeeksCache";

import type { Database } from "@/integrations/supabase/types";
import type { CarType } from "@/lib/enums";

/**
 * The only file in the `siddur` feature that calls `supabase.from`/`.rpc`.
 * Covers `departments`, `weeks` and the published-siddur read views —
 * reference data several features (Home, board, the Sadran tab gate) all
 * need, so it lives here rather than duplicated per feature.
 */
export type Department = Database["public"]["Tables"]["departments"]["Row"];
export type Week = Database["public"]["Tables"]["weeks"]["Row"];
export type BoardRide = Database["public"]["Views"]["v_board_rides"]["Row"];
export type MyUpcomingRide = BoardRide & {
  car_name: string | null;
  car_type: CarType | null;
};

/**
 * Every upcoming/ongoing ride I am on: I drive it, a request of mine (as requester or companion) is on it,
 * or I am named on it as a `ride_passengers.person_id` (F3, 20260914120000_ride_passengers.sql — a
 * Sadran-made reservation with no request behind it, e.g.). Two calls: (1) the `my_upcoming_rides` RPC
 * (security invoker, so RLS decides visibility exactly as for a direct view read) — it collects my ride
 * ids first and reads the `v_board_rides` view for just those, instead of aggregating every ride of the
 * week and filtering `people` afterwards; (2) one `cars` lookup for the resulting car ids.
 */
export async function fetchMyUpcomingRides(profileId: string, departmentId?: string): Promise<MyUpcomingRide[]> {
  const now = new Date().toISOString();
  // One call: `my_upcoming_rides` (20261028110000, security invoker — same RLS as the old queries) finds my ride ids
  // (driver / own or companion request / named passenger) first and reads `v_board_rides` for just those.
  const { data, error } = await supabase.rpc("my_upcoming_rides", { p_department_id: departmentId, p_now: now });
  if (error) throw toAppError(error);
  const rides: BoardRide[] = [];
  for (const ride of data ?? []) {
    // The one selection rule (`features/rides/myRides.ts`): a draft ride only when I drive or am named on it.
    if (ride.id && (ride.status !== "draft" || isMyDraftRide(ride, profileId))) rides.push(ride);
  }
  return withCarNames(rides, departmentId);
}

/** Upcoming rides whose `people` list holds `person` (`{person_id}` or `{child_id}`) — jsonb containment on the view. */
async function fetchRidesWithPerson(person: { person_id: string } | { child_id: string }, now: string, statuses: ("confirmed" | "flagged" | "draft")[]): Promise<BoardRide[]> {
  // postgrest-js turns an array argument into a Postgres array literal, so the JSON goes in as a string.
  const { data, error } = await supabase.from("v_board_rides").select("*")
    .in("status", statuses).gt("ends_at", now)
    .contains("people", JSON.stringify([person]))
    .order("starts_at").order("id");
  if (error) throw toAppError(error);
  return data ?? [];
}

async function withCarNames(rideList: BoardRide[], departmentId?: string): Promise<MyUpcomingRide[]> {
  const rides = new Map<string, BoardRide>();
  for (const ride of rideList) if (ride.id) rides.set(ride.id, ride);

  const carIds = [...new Set([...rides.values()].flatMap((ride) => ride.car_id ? [ride.car_id] : []))];
  const cars = new Map<string, { label: string; type: CarType }>();
  if (carIds.length) {
    const { data: carRows, error: carError } = await supabase.from("cars")
      .select("id, name, type, codes:car_access_codes(access_code, is_replaced, replacement_code)")
      .in("id", carIds);
    if (carError) throw toAppError(carError);
    for (const car of carRows ?? []) {
      const codes = Array.isArray(car.codes) ? car.codes[0] : car.codes;
      cars.set(car.id, {
        label: siddurCarName({
          name: car.name,
          access_code: codes?.access_code ?? null,
          is_replaced: codes?.is_replaced ?? false,
          replacement_code: codes?.replacement_code ?? null,
        }),
        type: car.type,
      });
    }
  }
  return [...rides.values()]
    .filter((ride) => !departmentId || ride.department_id === departmentId)
    .sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? "") || (a.id ?? "").localeCompare(b.id ?? ""))
    .map((ride) => ({ ...ride, car_name: cars.get(ride.car_id ?? "")?.label ?? null, car_type: cars.get(ride.car_id ?? "")?.type ?? null }));
}

export interface MyChild {
  id: string;
  name: string;
}

/** My children (`child_guardians` rows are readable by their own guardian only — RLS). */
export async function fetchMyChildren(profileId: string): Promise<MyChild[]> {
  const { data, error } = await supabase.from("child_guardians")
    .select("child_id, child:children!child_guardians_child_id_fkey(full_name)")
    .eq("profile_id", profileId);
  if (error) throw toAppError(error);
  return (data ?? []).map((row) => ({ id: row.child_id, name: row.child?.full_name ?? "" }));
}

/**
 * Display-only "children's rides" (owner 2026-10-16, REQ §13.128): upcoming published rides with one of my children
 * on them (`people` child row — a request's `request_children` included), plus the rides of the children's OTHER
 * guardians (`guardianIds` from `my_co_guardians`: `child_guardians` hides their rows from members under RLS).
 */
export async function fetchMyChildrenRides(childIds: readonly string[], departmentId?: string, guardianIds: readonly string[] = []): Promise<MyUpcomingRide[]> {
  if (!childIds.length) return [];
  const now = new Date().toISOString();
  const lists = await Promise.all([
    ...childIds.map((id) => fetchRidesWithPerson({ child_id: id }, now, ["confirmed", "flagged"])),
    ...guardianIds.map((id) => fetchRidesWithPerson({ person_id: id }, now, ["confirmed", "flagged"])),
  ]);
  return withCarNames(lists.flat(), departmentId);
}

/** Profile ids of the other guardians of my children in the department (REQ §13.134); empty when none. */
export async function fetchMyCoGuardianIds(departmentId: string): Promise<string[]> {
  const rows = await rpc("my_co_guardians", { p_department_id: departmentId });
  return [...new Set((rows ?? []).map((row) => row.profile_id))].sort();
}

// `RideChange`, `RideMove` and the ride-change/passenger-list/notes RPCs moved to
// `src/features/rides/api.ts` (REFACTOR_BACKLOG "R8: break the siddur ⇄ sadran import cycle") —
// they are shared by both the siddur and sadran board, not siddur-specific.

export async function fetchDepartments(): Promise<Department[]> {
  const { data, error } = await supabase.from("departments").select("*").eq("is_active", true);
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchCurrentWeekStart(): Promise<string> {
  // Zero-argument RPC: `rpc<T>()`'s generic Args type is `never` here, so
  // this one call goes straight through supabase-js instead of the helper.
  const { data, error } = await supabase.rpc("current_week_start");
  if (error) throw toAppError(error);
  return data;
}

async function runEnsureDepartmentWeeks(departmentId: string): Promise<void> {
  try {
    await rpc("ensure_department_weeks", { p_department_id: departmentId });
  } catch (error) {
    // Published schedules remain readable across departments; catch-up only mutates memberships.
    if (!(error instanceof AppError) || error.code !== "not_authorized") throw error;
  }
}

/** At most once per department per session (`ensureWeeksCache.ts`), not before every week read. */
export function ensureDepartmentWeeks(departmentId: string): Promise<void> {
  return ensureOncePerSession(departmentId, runEnsureDepartmentWeeks);
}

export async function fetchWeeks(departmentId: string): Promise<Week[]> {
  await ensureDepartmentWeeks(departmentId);
  const { data, error } = await supabase
    .from("weeks")
    .select("*")
    .eq("department_id", departmentId)
    .order("week_start", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

/**
 * `week_start` values currently `open` or `live` for a department — the set
 * `useIsSadranAnywhere` checks against to decide whether the Sadran tab
 * shows (UX_FLOWS.md §2.2: "while assigned to at least one department/week").
 */
export async function fetchOpenAndLiveWeekStarts(departmentId: string): Promise<string[]> {
  await ensureDepartmentWeeks(departmentId);
  const { data, error } = await supabase
    .from("weeks")
    .select("week_start")
    .eq("department_id", departmentId)
    .in("phase", ["open", "solving", "published", "live"]);
  if (error) throw toAppError(error);
  return (data ?? []).map((row) => row.week_start);
}

/**
 * The rides of a department/week as the caller may see them — exactly the `v_board_rides` rows for that
 * week, read through `week_board_rides` (20261028120000, security invoker: same RLS, each table read once).
 */
export async function fetchBoardRides(departmentId: string, weekStart: string): Promise<BoardRide[]> {
  const { data, error } = await supabase
    .rpc("week_board_rides", { p_department_id: departmentId, p_week_start: weekStart })
    .order("starts_at", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

/** A single ride for the ride-detail sheet / "ask to join" prefill (`?ride=<id>`). */
export async function fetchBoardRideById(rideId: string): Promise<BoardRide | null> {
  const { data, error } = await supabase.from("v_board_rides").select("*").eq("id", rideId).maybeSingle();
  if (error) throw toAppError(error);
  return data ?? null;
}

/** Car type/owner for a ride's car — used to word the "ask to join" confirmation (REQ §13.43). */
export async function fetchCarForRide(carId: string): Promise<{ type: CarType; ownerId: string | null } | null> {
  const { data, error } = await supabase.from("cars").select("type, owner_id").eq("id", carId).maybeSingle();
  if (error) throw toAppError(error);
  return data ? { type: data.type, ownerId: data.owner_id } : null;
}

/** Where a shared car is right now (away from home) — the board's location badge (REQ §5.4/§7.4). */
export type CarLocation = Database["public"]["Views"]["v_car_locations"]["Row"];

export async function fetchCarLocations(departmentId: string, weekStart: string): Promise<CarLocation[]> {
  const { data, error } = await supabase
    .from("v_car_locations")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart);
  if (error) throw toAppError(error);
  return data ?? [];
}

/** `car_start_locations()` (REQ §13.93): where each car stands at the week's start, keyed by car id (location null-safe). */
export async function fetchCarStartLocationIds(departmentId: string, weekStart: string): Promise<Record<string, string>> {
  const rows = await rpc("car_start_locations", { p_department_id: departmentId, p_week_start: weekStart });
  return Object.fromEntries((rows ?? []).map((row) => [row.car_id, row.location_id]));
}

// `RidePassengerInput`, `addRidePassengers()`, `removeRidePerson()` moved to
// `src/features/rides/api.ts` alongside `RideMove`/`RideChange` (R8, same reason).
