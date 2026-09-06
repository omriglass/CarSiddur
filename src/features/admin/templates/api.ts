import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/** The only file in `admin/templates` that calls `supabase.from` (admin-writable directly, DATA_MODEL.md §4.3). */
export type NotificationTemplate = Database["public"]["Tables"]["notification_templates"]["Row"];
export type NotificationTemplateUpdate = Database["public"]["Tables"]["notification_templates"]["Update"];

export async function fetchNotificationTemplates(): Promise<NotificationTemplate[]> {
  const { data, error } = await supabase
    .from("notification_templates")
    .select("*")
    .order("event", { ascending: true })
    .order("channel", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function updateNotificationTemplate(id: string, patch: NotificationTemplateUpdate): Promise<NotificationTemplate> {
  const { data, error } = await supabase.from("notification_templates").update(patch).eq("id", id).select().single();
  if (error) throw toAppError(error);
  return data;
}
