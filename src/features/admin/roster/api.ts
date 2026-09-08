import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/**
 * The only file in `admin/roster` that accesses the database.
 * Replacements use an admin RPC so promotion and assignments commit atomically.
 */
export type SadranAssignment = Database["public"]["Tables"]["sadran_assignments"]["Row"];

/** Explicit per-week rows plus every department's standing default (`week_start is null`). */
export async function fetchSadranAssignments(weekStarts: string[]): Promise<SadranAssignment[]> {
  const { data, error } = await supabase
    .from("sadran_assignments")
    .select("*")
    .or(`week_start.in.(${weekStarts.join(",")}),week_start.is.null`);
  if (error) throw toAppError(error);
  return data ?? [];
}

/** Atomically promotes eligible members and replaces this week's assignments. */
export async function setWeekAssignments(departmentId: string, weekStart: string, profileIds: string[]): Promise<void> {
  await rpc("admin_set_sadran_assignments", { p_department_id: departmentId, p_week_start: weekStart, p_profile_ids: profileIds });
}

/** Omitting the week selects the standing default roster. */
export async function setStandingDefault(departmentId: string, profileIds: string[]): Promise<void> {
  await rpc("admin_set_sadran_assignments", { p_department_id: departmentId, p_profile_ids: profileIds });
}
