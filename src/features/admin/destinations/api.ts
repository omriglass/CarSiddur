import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/**
 * The only file in `admin/destinations` that calls `supabase.from`.
 * `destinations` is admin-writable directly (DATA_MODEL.md §4.3).
 */
export type Destination = Database["public"]["Tables"]["destinations"]["Row"];
export type DestinationInsert = Database["public"]["Tables"]["destinations"]["Insert"];
export type DestinationUpdate = Database["public"]["Tables"]["destinations"]["Update"];

export async function fetchAllDestinations(): Promise<Destination[]> {
  const { data, error } = await supabase.from("destinations").select("*").order("name", { ascending: true });
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
export async function fetchFreeTextQueue(): Promise<FreeTextGroup[]> {
  const { data, error } = await supabase
    .from("requests")
    .select("destination_text, created_at")
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
