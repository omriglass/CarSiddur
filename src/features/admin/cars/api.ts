import { fetchOperationalDepartments } from "@/features/admin/operationsApi";
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
/**
 * `access_code`/`is_replaced`/`replacement_code` moved out of `cars` into
 * `car_access_codes` (one row per car, department-scoped RLS) — flattened
 * back onto `Car` here so `CarForm` and callers keep working unchanged.
 */
export interface CarCodes {
  access_code: string | null;
  is_replaced: boolean;
  replacement_code: string | null;
}
export type Car = Database["public"]["Tables"]["cars"]["Row"] & CarCodes;
export type CarInsert = Database["public"]["Tables"]["cars"]["Insert"] & Partial<CarCodes>;
export type CarUpdate = Database["public"]["Tables"]["cars"]["Update"] & Partial<CarCodes>;
export type SeatConfig = Database["public"]["Tables"]["car_seat_configs"]["Row"];
export type MaintenanceBlock = Database["public"]["Tables"]["car_maintenance_blocks"]["Row"];
export type CarIssue = Database["public"]["Tables"]["car_issues"]["Row"];

export const CARS_WITH_CODES_SELECT = "*, codes:car_access_codes(access_code, is_replaced, replacement_code)";

/** Flattens the `codes:car_access_codes(...)` embed onto the row (null/absent → not replaced, no codes). */
export function flattenCarCodes<T extends { codes?: CarCodes | CarCodes[] | null }>(
  row: T,
): Omit<T, "codes"> & CarCodes {
  const { codes, ...rest } = row;
  const flat = Array.isArray(codes) ? codes[0] : codes;
  return {
    ...rest,
    access_code: flat?.access_code ?? null,
    is_replaced: flat?.is_replaced ?? false,
    replacement_code: flat?.replacement_code ?? null,
  } as Omit<T, "codes"> & CarCodes;
}

export async function fetchCarsAll(): Promise<Car[]> {
  const { data, error } = await supabase.from("cars").select(CARS_WITH_CODES_SELECT).order("name", { ascending: true });
  if (error) throw toAppError(error);
  const departmentIds = new Set((await fetchOperationalDepartments()).map((department) => department.id));
  return ((data ?? []) as unknown as (Database["public"]["Tables"]["cars"]["Row"] & { codes: CarCodes | CarCodes[] | null })[])
    .filter((row) => departmentIds.has(row.department_id))
    .map(flattenCarCodes);
}

async function upsertCarCodes(carId: string, departmentId: string, codes: Partial<CarCodes>): Promise<void> {
  const { error } = await supabase.from("car_access_codes").upsert(
    {
      car_id: carId,
      department_id: departmentId,
      access_code: codes.access_code ?? null,
      is_replaced: codes.is_replaced ?? false,
      replacement_code: codes.replacement_code ?? null,
    },
    { onConflict: "car_id" },
  );
  if (error) throw toAppError(error);
}

export async function createCar(input: CarInsert): Promise<Car> {
  const { access_code, is_replaced, replacement_code, ...carInput } = input;
  const { data, error } = await supabase.from("cars").insert(carInput).select().single();
  if (error) throw toAppError(error);
  await upsertCarCodes(data.id, data.department_id, { access_code, is_replaced, replacement_code });
  return { ...data, access_code: access_code ?? null, is_replaced: is_replaced ?? false, replacement_code: replacement_code ?? null };
}

export async function updateCar(id: string, patch: CarUpdate): Promise<Car> {
  const { access_code, is_replaced, replacement_code, ...carPatch } = patch;
  const { data, error } = await supabase.from("cars").update(carPatch).eq("id", id).select().single();
  if (error) throw toAppError(error);
  await upsertCarCodes(id, data.department_id, { access_code, is_replaced, replacement_code });
  return { ...data, access_code: access_code ?? null, is_replaced: is_replaced ?? false, replacement_code: replacement_code ?? null };
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
  const departmentIds = new Set((await fetchOperationalDepartments()).map((department) => department.id));
  return (data ?? []).filter((row) => departmentIds.has(row.department_id));
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
  const departmentIds = new Set((await fetchOperationalDepartments()).map((department) => department.id));
  return (data ?? []).filter((row) => departmentIds.has(row.department_id));
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
