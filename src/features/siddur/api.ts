import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

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

export async function fetchWeeks(departmentId: string): Promise<Week[]> {
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
  const { data, error } = await supabase
    .from("weeks")
    .select("week_start")
    .eq("department_id", departmentId)
    .in("phase", ["open", "live"]);
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
 * `department_settings.board_start_time` only — the member grid's default
 * visible-range start (UX_FLOWS.md §20, same field the Sadran board reads
 * via its own `fetchDepartmentSettings`; a minimal, single-column read here
 * rather than pulling in the whole `sadran` feature's settings row).
 */
export async function fetchBoardStartTime(departmentId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("department_settings")
    .select("board_start_time")
    .eq("department_id", departmentId)
    .maybeSingle();
  if (error) throw toAppError(error);
  return data?.board_start_time ?? null;
}
