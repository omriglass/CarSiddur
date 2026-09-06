import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";
import type { Passengers } from "@/solver";

/**
 * The only file in `admin/cars` that calls `supabase.from`/`.rpc`.
 * `cars`, `car_seat_configs`, `car_maintenance_blocks` and `car_issues` are
 * admin-writable directly (DATA_MODEL.md §4.3); moving an unsafe issue to a
 * maintenance block is a multi-row operation, done via the
 * `report_car_issue_unsafe_to_maintenance` RPC.
 */
export type Car = Database["public"]["Tables"]["cars"]["Row"];
export type CarInsert = Database["public"]["Tables"]["cars"]["Insert"];
export type CarUpdate = Database["public"]["Tables"]["cars"]["Update"];
export type SeatConfig = Database["public"]["Tables"]["car_seat_configs"]["Row"];
export type MaintenanceBlock = Database["public"]["Tables"]["car_maintenance_blocks"]["Row"];
export type CarIssue = Database["public"]["Tables"]["car_issues"]["Row"];

export async function fetchCarsAll(): Promise<Car[]> {
  const { data, error } = await supabase.from("cars").select("*").order("name", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function createCar(input: CarInsert): Promise<Car> {
  const { data, error } = await supabase.from("cars").insert(input).select().single();
  if (error) throw toAppError(error);
  return data;
}

export async function updateCar(id: string, patch: CarUpdate): Promise<Car> {
  const { data, error } = await supabase.from("cars").update(patch).eq("id", id).select().single();
  if (error) throw toAppError(error);
  return data;
}

export async function fetchSeatConfigs(carId: string): Promise<SeatConfig[]> {
  const { data, error } = await supabase.from("car_seat_configs").select("*").eq("car_id", carId);
  if (error) throw toAppError(error);
  return data ?? [];
}

/** Bulk variant for the policy preview's `buildSolverInput()` bridge (one query for many cars). */
export async function fetchSeatConfigsForCars(carIds: string[]): Promise<Record<string, SeatConfig[]>> {
  if (carIds.length === 0) return {};
  const { data, error } = await supabase.from("car_seat_configs").select("*").in("car_id", carIds);
  if (error) throw toAppError(error);
  const byCarId: Record<string, SeatConfig[]> = {};
  for (const row of data ?? []) {
    (byCarId[row.car_id] ??= []).push(row);
  }
  return byCarId;
}

/** Replaces all seat configuration rows of a car with `configs` (delete-then-insert, small table). */
export async function replaceSeatConfigs(carId: string, configs: Passengers[]): Promise<void> {
  const del = await supabase.from("car_seat_configs").delete().eq("car_id", carId);
  if (del.error) throw toAppError(del.error);
  if (configs.length === 0) return;
  const ins = await supabase.from("car_seat_configs").insert(
    configs.map((c) => ({ car_id: carId, adults: c.adults, child_seats: c.childSeats, boosters: c.boosters })),
  );
  if (ins.error) throw toAppError(ins.error);
}

export async function fetchMaintenanceBlocks(): Promise<MaintenanceBlock[]> {
  const { data, error } = await supabase
    .from("car_maintenance_blocks")
    .select("*")
    .order("starts_at", { ascending: false });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function createMaintenanceBlock(input: {
  carId: string;
  departmentId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
}): Promise<MaintenanceBlock> {
  const { data, error } = await supabase
    .from("car_maintenance_blocks")
    .insert({
      car_id: input.carId,
      department_id: input.departmentId,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      reason: input.reason,
      created_by: (await supabase.auth.getUser()).data.user?.id ?? "",
    })
    .select()
    .single();
  if (error) throw toAppError(error);
  return data;
}

/** Ends a block now (shortens `ends_at` to now instead of deleting, keeping history). */
export async function endMaintenanceBlockNow(blockId: string): Promise<void> {
  const { error } = await supabase
    .from("car_maintenance_blocks")
    .update({ ends_at: new Date().toISOString() })
    .eq("id", blockId);
  if (error) throw toAppError(error);
}

export async function fetchCarIssues(): Promise<CarIssue[]> {
  const { data, error } = await supabase.from("car_issues").select("*").order("created_at", { ascending: false });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function resolveCarIssue(issueId: string): Promise<void> {
  const { error } = await supabase
    .from("car_issues")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", issueId);
  if (error) throw toAppError(error);
}

export async function moveIssueToMaintenance(issueId: string, hours: number): Promise<string> {
  return rpc("report_car_issue_unsafe_to_maintenance", { p_issue_id: issueId, p_hours: hours });
}
