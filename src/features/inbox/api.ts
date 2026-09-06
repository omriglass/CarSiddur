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
