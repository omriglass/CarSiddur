import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/** The only file in the `inbox` feature that calls `supabase.from`. */
export type Notification = Database["public"]["Tables"]["notifications"]["Row"];

export async function fetchNotifications(profileId: string): Promise<Notification[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("recipient_id", profileId)
    .order("created_at", { ascending: false });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);
  if (error) throw toAppError(error);
}

export async function markAllNotificationsRead(profileId: string): Promise<void> {
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_id", profileId)
    .is("read_at", null);
  if (error) throw toAppError(error);
}

/** Unread count for the inbox tab badge (AppShell). */
export async function fetchUnreadNotificationCount(profileId: string): Promise<number> {
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_id", profileId)
    .is("read_at", null);
  if (error) throw toAppError(error);
  return count ?? 0;
}

/**
 * Resolves a member's own `/p/:token` link for a pending proposal. The
 * plaintext token is stored only on the `proposal_received` notification row
 * that was created for them (`data.proposal_id` / `data.url`, both computed
 * once by SQL's `notification_default_url()`, DATA_MODEL §3.11) — RLS scopes
 * this to the caller's own notifications, so no `recipient_id` filter is
 * needed here. Returns `null` if that notification can no longer be found
 * (e.g. it was deleted), letting the caller fall back to the inbox.
 */
export async function fetchProposalLink(proposalId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("notifications")
    .select("data")
    .eq("event", "proposal_received")
    .eq("data->>proposal_id", proposalId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw toAppError(error);
  const url = (data?.data as { url?: string } | null)?.url;
  return typeof url === "string" ? url : null;
}
