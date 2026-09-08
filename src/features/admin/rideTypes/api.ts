import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/** The only file in `admin/rideTypes` that calls `supabase.from` (admin-writable directly, DATA_MODEL.md §4.3). */
export type RideType = Database["public"]["Tables"]["ride_types"]["Row"];
export type RideTypeInsert = Database["public"]["Tables"]["ride_types"]["Insert"];
export type RideTypeUpdate = Database["public"]["Tables"]["ride_types"]["Update"];

export async function fetchAllRideTypes(departmentId: string): Promise<RideType[]> {
  const { data, error } = await supabase.from("ride_types").select("*").eq("department_id", departmentId).order("sort_order", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function createRideType(input: RideTypeInsert): Promise<RideType> {
  const { data, error } = await supabase.from("ride_types").insert(input).select().single();
  if (error) throw toAppError(error);
  return data;
}

export async function updateRideType(id: string, patch: RideTypeUpdate): Promise<RideType> {
  const { data, error } = await supabase.from("ride_types").update(patch).eq("id", id).select().single();
  if (error) throw toAppError(error);
  return data;
}
