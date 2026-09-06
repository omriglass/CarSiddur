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
export type Car = Database["public"]["Tables"]["cars"]["Row"];
export type Destination = Database["public"]["Tables"]["destinations"]["Row"];
export type RideType = Database["public"]["Tables"]["ride_types"]["Row"];

export async function fetchCars(departmentId: string): Promise<Car[]> {
  const { data, error } = await supabase
    .from("cars")
    .select("*")
    .eq("department_id", departmentId)
    .neq("status", "retired");
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchDestinations(): Promise<Destination[]> {
  const { data, error } = await supabase
    .from("destinations")
    .select("*")
    .eq("is_approved", true)
    .order("name", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchRideTypes(): Promise<RideType[]> {
  const { data, error } = await supabase
    .from("ride_types")
    .select("*")
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
export async function suggestDestination(name: string, zone = "unknown"): Promise<string> {
  return rpc("suggest_destination", { p_name: name, p_zone: zone });
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
