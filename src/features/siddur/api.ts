import { supabase } from "@/integrations/supabase/client";
import { AppError, rpc, toAppError } from "@/lib/rpc";
import { siddurCarName } from "@/lib/siddurCarName";

import type { Database } from "@/integrations/supabase/types";

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
  car_type: Database["public"]["Enums"]["car_type"] | null;
};

/**
 * Every upcoming/ongoing requested leg, plus designated-driver rides without
 * an own request. Three calls, none of them a client-side paging loop
 * (docs/HARDENING_2026-09.md §3 item 5): (1) one embedded `ride_requests`
 * query for the ride ids a request of mine reaches, restricted to
 * upcoming public-status rides before the id list is ever built; (2) one
 * `v_board_rides` read for those ids plus every ride I drive — kept as a
 * second call because the view carries the joined display fields
 * (`served`, names, …) a plain FK embed on `rides` cannot reach and, being a
 * view, offers no FK embed of its own; (3) one `cars` lookup for the
 * resulting car ids. A member's upcoming-ride set is always small enough for
 * a single `.in()`/`.or()` each — the old 500/100-row loops guarded against
 * an unbounded id list that never actually occurs here.
 */
export async function fetchMyUpcomingRides(profileId: string, departmentId?: string): Promise<MyUpcomingRide[]> {
  const now = new Date().toISOString();

  const { data: passengerRows, error: passengerError } = await supabase
    .from("ride_requests")
    .select("ride_id, request:requests!ride_requests_request_id_fkey!inner(requester_id), ride:rides!ride_requests_ride_id_fkey!inner(ends_at, status)")
    .eq("request.requester_id", profileId)
    .gt("ride.ends_at", now)
    .in("ride.status", ["confirmed", "flagged"]);
  if (passengerError) throw toAppError(passengerError);
  const passengerRideIds = [...new Set((passengerRows ?? []).map((row) => row.ride_id))];

  let boardQuery = supabase.from("v_board_rides").select("*")
    .in("status", ["confirmed", "flagged"]).gt("ends_at", now)
    .order("starts_at").order("id");
  boardQuery = passengerRideIds.length
    ? boardQuery.or(`driver_id.eq.${profileId},id.in.(${passengerRideIds.join(",")})`)
    : boardQuery.eq("driver_id", profileId);
  const { data: rideRows, error: rideError } = await boardQuery;
  if (rideError) throw toAppError(rideError);
  const rides = new Map<string, BoardRide>();
  for (const ride of rideRows ?? []) if (ride.id) rides.set(ride.id, ride);

  const carIds = [...new Set([...rides.values()].flatMap((ride) => ride.car_id ? [ride.car_id] : []))];
  const cars = new Map<string, { label: string; type: Database["public"]["Enums"]["car_type"] }>();
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
  return rpc("request_ride_change", {
    p_ride_id: move.rideId, p_car_id: move.carId,
    p_starts_at: move.startsAt, p_ends_at: move.endsAt, p_expected_version: move.expectedVersion,
  });
}

export async function respondRideChange(changeId: string, accept: boolean): Promise<void> {
  await rpc("respond_ride_change", { p_change_id: changeId, p_accept: accept });
}

export async function cancelRideChange(changeId: string): Promise<void> {
  await rpc("cancel_ride_change", { p_change_id: changeId });
}

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

export async function ensureDepartmentWeeks(departmentId: string): Promise<void> {
  try {
    await rpc("ensure_department_weeks", { p_department_id: departmentId });
  } catch (error) {
    // Published schedules remain readable across departments; catch-up only mutates memberships.
    if (!(error instanceof AppError) || error.code !== "not_authorized") throw error;
  }
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

/** Published siddur rides for a department/week (`v_board_rides`, security_invoker RLS). */
export async function fetchBoardRides(departmentId: string, weekStart: string): Promise<BoardRide[]> {
  const { data, error } = await supabase
    .from("v_board_rides")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
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
export async function fetchCarForRide(carId: string): Promise<{ type: Database["public"]["Enums"]["car_type"]; ownerId: string | null } | null> {
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

/**
 * Car id→name for the member-facing archive export (`MemberWeekExportButton`,
 * `src/features/siddur/export/`). `cars_select` is `is_approved()`-only (no
 * department/role gate), so any approved member may read this — including
 * retired cars, so an old archived week's export still shows real names
 * instead of raw ids (mirrors `fetchExportCars` in `sadran/export/api.ts`,
 * the Sadran-only equivalent).
 */
export async function fetchExportCarNames(departmentId: string): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.from("cars").select("id, name").eq("department_id", departmentId);
  if (error) throw toAppError(error);
  return data ?? [];
}
