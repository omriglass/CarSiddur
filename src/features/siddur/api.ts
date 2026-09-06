import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";

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
