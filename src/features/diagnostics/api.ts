import { supabase } from "@/integrations/supabase/client";

import type { ClientErrorRow } from "./report";

/**
 * The only file in the `diagnostics` feature that touches Supabase (CLAUDE.md Structure).
 * `client_errors` RLS: authenticated insert of own rows (rate-limited by trigger), admin select.
 */

/** The signed-in user's id, or null (no session: the table has no anon grant, so nothing to send). */
export async function currentProfileId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

/** Inserts one report. Resolves `false` on any failure; deliberately never throws or toasts. */
export async function insertClientError(row: ClientErrorRow): Promise<boolean> {
  try {
    const { error } = await supabase.from("client_errors").insert(row);
    return !error;
  } catch {
    return false;
  }
}

export interface ClientErrorListRow {
  id: number;
  created_at: string;
  message: string;
  stack: string | null;
  url: string | null;
  app_version: string | null;
  user_agent: string | null;
  profile_id: string | null;
  profiles: { full_name: string } | null;
}

export const CLIENT_ERRORS_LIMIT = 200;

/** Latest reports, newest first (admin-only by RLS). */
export async function fetchClientErrors(limit: number = CLIENT_ERRORS_LIMIT): Promise<ClientErrorListRow[]> {
  const { data, error } = await supabase
    .from("client_errors")
    .select("id, created_at, message, stack, url, app_version, user_agent, profile_id, profiles(full_name)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data as unknown as ClientErrorListRow[];
}
