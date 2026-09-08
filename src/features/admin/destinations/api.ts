import { supabase } from "@/integrations/supabase/client";
import { AppError, toAppError } from "@/lib/rpc";

import { he } from "@/i18n/he";

import type { Database } from "@/integrations/supabase/types";

/**
 * The only file in `admin/destinations` that calls `supabase.from`.
 * `destinations` is admin-writable directly (DATA_MODEL.md §4.3).
 */
export type Destination = Database["public"]["Tables"]["destinations"]["Row"];
export type DestinationInsert = Database["public"]["Tables"]["destinations"]["Insert"];
export type DestinationUpdate = Database["public"]["Tables"]["destinations"]["Update"];

export async function fetchAllDestinations(departmentId: string): Promise<Destination[]> {
  const { data, error } = await supabase.from("destinations").select("*").eq("department_id", departmentId).order("name", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function createDestination(input: DestinationInsert): Promise<Destination> {
  const { data, error } = await supabase.from("destinations").insert(input).select().single();
  if (error) throw toAppError(error);
  return data;
}

export async function updateDestination(id: string, patch: DestinationUpdate): Promise<Destination> {
  const { data, error } = await supabase.from("destinations").update(patch).eq("id", id).select().single();
  if (error) throw toAppError(error);
  return data;
}

export interface FreeTextGroup {
  text: string;
  count: number;
  lastUsedAt: string;
}

/**
 * Distinct free-text destinations members typed (`requests.destination_text`
 * where `destination_id is null`), grouped client-side (small table, no view
 * for this yet — see the stage 2c report). `requests` SELECT is open to
 * admin directly (DATA_MODEL.md §4.3), unlike its RPC-only writes.
 */
export async function fetchFreeTextQueue(departmentId: string): Promise<FreeTextGroup[]> {
  const { data, error } = await supabase
    .from("requests")
    .select("destination_text, created_at")
    .eq("department_id", departmentId)
    .is("destination_id", null)
    .not("destination_text", "is", null);
  if (error) throw toAppError(error);

  const groups = new Map<string, FreeTextGroup>();
  for (const row of data ?? []) {
    const text = (row.destination_text ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (row.created_at > existing.lastUsedAt) existing.lastUsedAt = row.created_at;
    } else {
      groups.set(key, { text, count: 1, lastUsedAt: row.created_at });
    }
  }
  return [...groups.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

/**
 * Merges a free-text destination into an existing preset by adding it as an
 * alias (admin direct write). Does **not** relink already-submitted
 * requests — `requests.destination_id`/`destination_text` are RPC-only
 * columns (DATA_MODEL.md §4.3, `submit_request` is the only writer) and no
 * shipped RPC performs this backfill; see the stage 2c report/UX_FLOWS §12.
 */
export async function mergeFreeTextIntoDestination(destinationId: string, freeText: string): Promise<Destination> {
  const { data: current, error: fetchError } = await supabase
    .from("destinations")
    .select("aliases")
    .eq("id", destinationId)
    .single();
  if (fetchError) throw toAppError(fetchError);
  const aliases = current.aliases.includes(freeText) ? current.aliases : [...current.aliases, freeText];
  const { data, error } = await supabase
    .from("destinations")
    .update({ aliases })
    .eq("id", destinationId)
    .select()
    .single();
  if (error) throw toAppError(error);
  return data;
}


export async function calculateDestinationRoute(departmentId: string, destinationId: string): Promise<{ distance_km: number; travel_minutes: number }> {
  const { data, error } = await supabase.functions.invoke("destination-route", {
    body: { department_id: departmentId, destination_id: destinationId },
  });
  if (error) {
    let code: string | undefined;
    if (error.context instanceof Response) {
      try { code = (await error.context.json())?.error?.code; } catch { /* Gateway/network error has no function payload. */ }
    }
    const messages: Record<string, string> = {
      maps_not_configured: he.adminDestinations.mapsNotConfigured,
      home_not_configured: he.adminDestinations.mapsHomeMissing,
      destination_not_found: he.adminDestinations.mapsDestinationMissing,
      not_authorized: he.adminDestinations.mapsUnauthorized,
      route_not_found: he.adminDestinations.mapsNoRoute,
    };
    throw new AppError("unknown", messages[code ?? ""] ?? he.adminDestinations.mapsFailed);
  }
  if (!data || !Number.isFinite(data.distance_km) || data.distance_km < 0 || !Number.isInteger(data.travel_minutes) || data.travel_minutes < 0) {
    throw new AppError("unknown", he.adminDestinations.mapsFailed);
  }
  return { distance_km: data.distance_km, travel_minutes: data.travel_minutes };
}
