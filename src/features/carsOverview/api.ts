import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";

import type { ChecklistStatus, OverviewCar, OverviewCareEvent, OverviewKm } from "./rows";

/** Most recent care events read per kind: the latest per car is picked in `buildCarOverviewRows`. */
const CARE_EVENTS_LIMIT = 1000;

/**
 * The all-cars dashboard's reads (REQ item 150 e): four batched queries for the whole department, never one per
 * car. The only file of `features/carsOverview` that calls `supabase.from()`. RLS decides what is returned
 * (every member reads `cars`, `car_current_km`, `car_care_events`, `car_access_codes` of their department).
 */
export async function fetchCarsOverviewData(departmentId: string): Promise<{
  cars: OverviewCar[];
  km: OverviewKm[];
  careEvents: OverviewCareEvent[];
}> {
  const careQuery = (kind: "tire_fill" | "wash") =>
    supabase
      .from("car_care_events")
      .select("car_id, kind, created_at, tires")
      .eq("department_id", departmentId)
      .eq("kind", kind)
      .order("created_at", { ascending: false })
      .limit(CARE_EVENTS_LIMIT);
  const [cars, km, tires, washes] = await Promise.all([
    supabase
      .from("cars")
      .select("id, name, license_plate, status, type, retired_at, codes:car_access_codes(is_replaced)")
      .eq("department_id", departmentId)
      .eq("type", "shared")
      .neq("status", "retired")
      .order("name", { ascending: true }),
    supabase.from("car_current_km").select("car_id, km, recorded_at").eq("department_id", departmentId),
    careQuery("tire_fill"),
    careQuery("wash"),
  ]);
  for (const result of [cars, km, tires, washes]) if (result.error) throw toAppError(result.error);
  return {
    cars: (cars.data ?? []) as unknown as OverviewCar[],
    km: (km.data ?? []) as OverviewKm[],
    careEvents: [...(tires.data ?? []), ...(washes.data ?? [])] as OverviewCareEvent[],
  };
}

/**
 * Latest handover checklist per car of the department (`car_checklist_status` view, REQ item 150 d): green / not
 * green as of its date plus the labels of the failed items. One read for all cars.
 */
export async function fetchCarChecklistStatuses(departmentId: string): Promise<Record<string, ChecklistStatus>> {
  const { data, error } = await supabase
    .from("car_checklist_status")
    .select("car_id, completed_at, green, failures")
    .eq("department_id", departmentId);
  if (error) throw toAppError(error);
  const result: Record<string, ChecklistStatus> = {};
  for (const row of data ?? []) {
    if (!row.car_id || row.completed_at === null) continue;
    const failures = Array.isArray(row.failures) ? (row.failures as { label?: unknown }[]) : [];
    result[row.car_id] = {
      green: row.green === true,
      date: row.completed_at,
      failed: failures.map((failure) => (typeof failure.label === "string" ? failure.label : "")).filter(Boolean),
    };
  }
  return result;
}
