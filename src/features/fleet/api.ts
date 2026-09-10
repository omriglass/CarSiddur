import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/**
 * The only file in the `fleet` feature that calls `supabase.from`. Covers
 * `cars` plus the two catalog tables (`destinations`, `ride_types`) — small
 * read-mostly reference data with no better single home in the fixed
 * feature taxonomy (CLAUDE.md folder map); consolidated here rather than
 * duplicated per consumer.
 */
/**
 * `access_code`/`is_replaced`/`replacement_code` live in `car_access_codes`
 * (one row per car, department-scoped RLS), not on `cars` — flattened onto
 * `Car` here so `siddurCarName()` callers (`SiddurPage`, `RideDetailSheet`,
 * `MemberRideEditor`, `useDayFreeWindows`) keep working unchanged.
 */
export type Car = Database["public"]["Tables"]["cars"]["Row"] & {
  access_code?: string | null;
  is_replaced?: boolean;
  replacement_code?: string | null;
};
export type Destination = Database["public"]["Tables"]["destinations"]["Row"];
export type RideType = Database["public"]["Tables"]["ride_types"]["Row"];

interface CarCodesEmbed {
  access_code: string | null;
  is_replaced: boolean;
  replacement_code: string | null;
}

export async function fetchCars(departmentId: string): Promise<Car[]> {
  const { data, error } = await supabase
    .from("cars")
    .select("*, codes:car_access_codes(access_code, is_replaced, replacement_code)")
    .eq("department_id", departmentId)
    .neq("status", "retired");
  if (error) throw toAppError(error);
  return ((data ?? []) as unknown as (Database["public"]["Tables"]["cars"]["Row"] & { codes: CarCodesEmbed | CarCodesEmbed[] | null })[]).map(
    ({ codes, ...rest }) => {
      const flat = Array.isArray(codes) ? codes[0] : codes;
      return {
        ...rest,
        access_code: flat?.access_code ?? null,
        is_replaced: flat?.is_replaced ?? false,
        replacement_code: flat?.replacement_code ?? null,
      };
    },
  );
}

export async function fetchDestinations(departmentId: string): Promise<Destination[]> {
  const { data, error } = await supabase
    .from("destinations")
    .select("*")
    .eq("department_id", departmentId)
    .eq("is_approved", true)
    .order("name", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchRideTypes(departmentId: string): Promise<RideType[]> {
  const { data, error } = await supabase
    .from("ride_types")
    .select("*")
    .eq("department_id", departmentId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

export type SeatConfig = Database["public"]["Tables"]["car_seat_configs"]["Row"];

/** Seat configurations of every active car in a department, for the client-side seat-fit check. */
export async function fetchCarSeatConfigs(departmentId: string): Promise<SeatConfig[]> {
  const { data, error } = await supabase
    .from("car_seat_configs")
    .select("*, car:cars!inner(department_id, status)")
    .eq("car.department_id", departmentId)
    .eq("car.status", "active");
  if (error) throw toAppError(error);
  return ((data ?? []) as unknown as (SeatConfig & { car: unknown })[]).map(({ car: _car, ...rest }) => rest);
}

/**
 * Free-text destination, submitted for the admin merge queue (UX_FLOWS §5.6,
 * REQUIREMENTS §5.1). `submit_request` stores the free text on the request
 * itself; this is the separate `suggest_destination` RPC the request form
 * calls in parallel so it shows up for the admin to classify.
 */
export async function suggestDestination(departmentId: string, name: string, zone = "unknown"): Promise<string> {
  return rpc("suggest_destination", { p_department_id: departmentId, p_name: name, p_zone: zone });
}

/**
 * Registers a temporary (private) car for sharing (REQUIREMENTS §6.4, §13.53).
 * Direct insert, not an RPC — `cars_insert`/`car_seat_configs_insert` RLS
 * already allow `type = 'temporary' and owner_id = auth.uid()` (DATA_MODEL §4.3).
 */
export async function registerTemporaryCar(input: {
  departmentId: string;
  ownerId: string;
  name: string;
  licensePlate: string;
  seatConfig: { adults: number; childSeats: number; boosters: number };
}): Promise<Car> {
  const { data: car, error: carError } = await supabase
    .from("cars")
    .insert({
      department_id: input.departmentId,
      owner_id: input.ownerId,
      name: input.name,
      license_plate: input.licensePlate,
      type: "temporary",
      status: "active",
    })
    .select("*")
    .single();
  if (carError) throw toAppError(carError);

  const { error: seatError } = await supabase.from("car_seat_configs").insert({
    car_id: car.id,
    adults: input.seatConfig.adults,
    child_seats: input.seatConfig.childSeats,
    boosters: input.seatConfig.boosters,
  });
  if (seatError) throw toAppError(seatError);

  return car;
}

/**
 * `department_settings.turnaround_minutes` — the buffer the quick-request sheet's client-side
 * free-window pre-check (`features/siddur/freeWindows.ts`) needs to mirror `try_auto_approve()`.
 * Readable by any member of the department (`department_settings_select` RLS), not just Sadran/
 * Admin — see `20260907091400_rls.sql`.
 */
export async function fetchTurnaroundMinutes(departmentId: string): Promise<number> {
  const { data, error } = await supabase
    .from("department_settings")
    .select("turnaround_minutes")
    .eq("department_id", departmentId)
    .single();
  if (error) throw toAppError(error);
  return data.turnaround_minutes;
}

export interface MaintenanceBlockWindow {
  car_id: string;
  starts_at: string;
  ends_at: string;
}

/** Active maintenance blocks for every car in the department (member-readable, same RLS as above). */
export async function fetchMaintenanceBlocks(departmentId: string): Promise<MaintenanceBlockWindow[]> {
  const { data, error } = await supabase
    .from("car_maintenance_blocks")
    .select("car_id, starts_at, ends_at")
    .eq("department_id", departmentId);
  if (error) throw toAppError(error);
  return data ?? [];
}

/** My own temporary cars (Profile "רכב פרטי לשיתוף"). */
export async function fetchMyTemporaryCars(ownerId: string): Promise<Car[]> {
  const { data, error } = await supabase
    .from("cars")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("type", "temporary");
  if (error) throw toAppError(error);
  return data ?? [];
}
