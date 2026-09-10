import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";

import { CARS_WITH_CODES_SELECT, flattenCarCodes } from "@/features/admin/cars/api";

import type { CarCodes, Car, CarIssue } from "@/features/admin/cars/api";
import type { Database } from "@/integrations/supabase/types";

/**
 * The only file in `features/cars` that calls `supabase.from(...)`. Owns the
 * car page (`/cars/:carId`, `docs/UX_FLOWS.md` §5.11): fetching one car by
 * id (any department — RLS lets every approved member read `cars`,
 * DATA_MODEL.md §4.3) plus its issue/care history. Writes (car fields, seat
 * configs) go through `CarForm`'s existing `features/admin/cars/hooks`
 * mutations, reused as-is rather than duplicated here — RLS gates the
 * actual write to `is_car_responsible(id) ∨ is_admin()` either way.
 */
export type CarCareEvent = Database["public"]["Tables"]["car_care_events"]["Row"];

interface ReporterName {
  reported_by_profile: { full_name: string } | null;
}

export type CarIssueWithReporter = CarIssue & ReporterName;
export type CarCareEventWithReporter = CarCareEvent & ReporterName;

export async function fetchCarById(carId: string): Promise<Car | null> {
  const { data, error } = await supabase.from("cars").select(CARS_WITH_CODES_SELECT).eq("id", carId).maybeSingle();
  if (error) throw toAppError(error);
  if (!data) return null;
  return flattenCarCodes(data as unknown as Database["public"]["Tables"]["cars"]["Row"] & { codes: CarCodes | CarCodes[] | null });
}

export async function fetchCarIssueHistory(carId: string): Promise<CarIssueWithReporter[]> {
  const { data, error } = await supabase
    .from("car_issues")
    .select("*, reported_by_profile:profiles!car_issues_reported_by_fkey(full_name)")
    .eq("car_id", carId)
    .order("created_at", { ascending: false });
  if (error) throw toAppError(error);
  return (data ?? []) as unknown as CarIssueWithReporter[];
}

export async function fetchCarCareHistory(carId: string): Promise<CarCareEventWithReporter[]> {
  const { data, error } = await supabase
    .from("car_care_events")
    .select("*, reported_by_profile:profiles!car_care_events_reported_by_fkey(full_name)")
    .eq("car_id", carId)
    .order("created_at", { ascending: false });
  if (error) throw toAppError(error);
  return (data ?? []) as unknown as CarCareEventWithReporter[];
}

/** Cars for the "הרכבים באחריותי" Home card — every non-retired car whose `responsible_id` is me. */
export async function fetchMyResponsibleCars(profileId: string): Promise<Car[]> {
  const { data, error } = await supabase
    .from("cars")
    .select(CARS_WITH_CODES_SELECT)
    .eq("responsible_id", profileId)
    .neq("status", "retired")
    .order("name", { ascending: true });
  if (error) throw toAppError(error);
  return ((data ?? []) as unknown as (Database["public"]["Tables"]["cars"]["Row"] & { codes: CarCodes | CarCodes[] | null })[]).map(
    flattenCarCodes,
  );
}
