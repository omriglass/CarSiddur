import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import { CARS_WITH_CODES_SELECT, flattenCarCodes } from "@/features/admin/cars/api";

import type { CarCodes, Car, CarIssue } from "@/features/admin/cars/api";
import type { Database } from "@/integrations/supabase/types";
import type { CarUseScope } from "@/lib/enums";

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

export type CarOdometerReading = Database["public"]["Tables"]["car_odometer_readings"]["Row"];
export type CarOdometerReadingWithReporter = CarOdometerReading & ReporterName;
/** `car_current_km` view row (REQ item 150 c): the car's latest reading or correction. */
export type CarCurrentKm = Pick<CarOdometerReading, "car_id" | "km" | "kind" | "recorded_at">;

interface ReporterName {
  reported_by_profile: { full_name: string } | null;
}

/** CR2: who marked it handled (owner 2026-11-20: the history says when and by whom). */
export type CarIssueWithReporter = CarIssue & ReporterName & { resolved_by_profile?: { full_name: string } | null };
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
    .select("*, reported_by_profile:profiles!car_issues_reported_by_fkey(full_name), resolved_by_profile:profiles!car_issues_resolved_by_fkey(full_name)")
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

export async function fetchCarOdometerHistory(carId: string): Promise<CarOdometerReadingWithReporter[]> {
  const { data, error } = await supabase
    .from("car_odometer_readings")
    .select("*, reported_by_profile:profiles!car_odometer_readings_recorded_by_fkey(full_name)")
    .eq("car_id", carId)
    .order("recorded_at", { ascending: false });
  if (error) throw toAppError(error);
  return (data ?? []) as unknown as CarOdometerReadingWithReporter[];
}

/** The car's current kilometrage (`car_current_km` view) or null when no reading exists yet. */
export async function fetchCarCurrentKm(carId: string): Promise<CarCurrentKm | null> {
  const { data, error } = await supabase
    .from("car_current_km")
    .select("car_id, km, kind, recorded_at")
    .eq("car_id", carId)
    .maybeSingle();
  if (error) throw toAppError(error);
  return (data as CarCurrentKm | null) ?? null;
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

/** MC1 (REQ item 218): the cars of my current rides, with their codes (members of the car's department read them). */
export async function fetchCarsByIds(carIds: readonly string[]): Promise<Car[]> {
  if (!carIds.length) return [];
  const { data, error } = await supabase.from("cars").select(CARS_WITH_CODES_SELECT).in("id", [...carIds]);
  if (error) throw toAppError(error);
  const cars = ((data ?? []) as unknown as (Database["public"]["Tables"]["cars"]["Row"] & { codes: CarCodes | CarCodes[] | null })[]).map(flattenCarCodes);
  return [...carIds].flatMap((id) => cars.filter((car) => car.id === id));
}

/** Upcoming non-cancelled rides of a car (for the "make private" warning). Reads only what RLS returns. */
export async function fetchUpcomingCarRides(carId: string): Promise<{ id: string; driver_id: string | null }[]> {
  const { data, error } = await supabase
    .from("rides")
    .select("id, driver_id")
    .eq("car_id", carId)
    .gt("ends_at", new Date().toISOString())
    .neq("status", "cancelled");
  if (error) throw toAppError(error);
  return data ?? [];
}

/**
 * Status-only update (REQ item 150 a): a car administrator of a private (temporary) car may change nothing else, the
 * `cars_protect_owner_editable_fields` trigger enforces it; this never touches the access-code row.
 */
export async function setCarStatusOnly(carId: string, status: Database["public"]["Enums"]["car_status"]): Promise<void> {
  const { error } = await supabase.from("cars").update({ status }).eq("id", carId);
  if (error) throw toAppError(error);
}

/**
 * R19B13 (REQ item 215): the private car's own owner hands it to another department member, or gives it back to the
 * fleet (`ownerId` null). Admins, the Sadran and the responsible person keep using the car update.
 */
export async function setOwnPrivateCar(carId: string, ownerId: string | null): Promise<void> {
  await rpc("set_own_private_car", { p_car_id: carId, ...(ownerId ? { p_owner_id: ownerId } : {}) });
}

/** PC1 (REQ item 227): any owner, the department's Sadran or an admin adds an owner (an approved department member). */
export async function addCarOwner(carId: string, profileId: string): Promise<void> {
  await rpc("add_car_owner", { p_car_id: carId, p_profile_id: profileId });
}

/** PE1 (REQ item 263): any owner sets who else may use the private car. */
export async function setCarUseScope(carId: string, scope: CarUseScope): Promise<void> {
  await rpc("set_car_use_scope", { p_car_id: carId, p_scope: scope });
}

/** PE1: per private car of the department, who besides its owners may use it that week (server: `may_use_private_car`). */
export async function fetchPrivateCarUsers(departmentId: string, weekStart: string | null): Promise<{ car_id: string; person_id: string }[]> {
  return (await rpc("private_car_users", { p_department: departmentId, ...(weekStart ? { p_week: weekStart } : {}) })) ?? [];
}

/** PC1: removes an owner — never the last one (`car_last_owner`). */
export async function removeCarOwner(carId: string, profileId: string): Promise<void> {
  await rpc("remove_car_owner", { p_car_id: carId, p_profile_id: profileId });
}

/** CR1 (REQ item 257): a car's open issue, as the car page banner, the report dialog and `/my` show it. */
export type OpenCarIssue = Pick<CarIssue, "id" | "car_id" | "description" | "is_unsafe" | "created_at" | "reported_by">;

/** The open issues of `carIds`, oldest first (RLS: members of the car's department, admins). */
export async function fetchOpenCarIssues(carIds: readonly string[]): Promise<OpenCarIssue[]> {
  if (carIds.length === 0) return [];
  const { data, error } = await supabase
    .from("car_issues")
    .select("id, car_id, description, is_unsafe, created_at, reported_by")
    .in("car_id", [...carIds])
    .eq("status", "open")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

/** CR1: every corporation name already used on a car, for the "תאגיד" suggestions (no list table, owner 2026-11-19). */
export async function fetchCarCorporations(): Promise<string[]> {
  const { data, error } = await supabase.from("cars").select("corporation").not("corporation", "is", null);
  if (error) throw toAppError(error);
  return [...new Set((data ?? []).map((row) => (row.corporation ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "he"));
}

/** CG1 (REQ item 259): every model name already used on a car, for the "יצרן ודגם" suggestions (no list table). */
export async function fetchCarModels(): Promise<string[]> {
  const { data, error } = await supabase.from("cars").select("model").not("model", "is", null);
  if (error) throw toAppError(error);
  return [...new Set((data ?? []).map((row) => (row.model ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "he"));
}

/** CR2 (REQ item 257 b): mark an open issue taken care of, or reword it (`update_car_issue`; no notification). */
export async function updateCarIssue(issueId: string, action: "resolve" | "edit", description?: string): Promise<void> {
  await rpc("update_car_issue", { p_issue_id: issueId, p_action: action, ...(description !== undefined ? { p_description: description } : {}) });
}
