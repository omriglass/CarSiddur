import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/**
 * The only file in `admin/roster` that accesses the database.
 * Replacements use an admin RPC so role-pool edits and weekly assignments commit atomically.
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

/** Assigns approved members for this week without changing permanent roles. */
export async function setWeekAssignments(departmentId: string, weekStart: string, profileIds: string[]): Promise<void> {
  await rpc("admin_set_sadran_assignments", { p_department_id: departmentId, p_week_start: weekStart, p_profile_ids: profileIds });
}

/** Omitting the week selects the standing default roster. */
export async function setStandingDefault(departmentId: string, profileIds: string[]): Promise<void> {
  await rpc("admin_set_sadran_assignments", { p_department_id: departmentId, p_profile_ids: profileIds });
}

/** Resolve duty independently of board permissions, including automatic rotation previews. */
export async function fetchDutyRoster(departmentIds: string[], weekStarts: string[]) {
  return Promise.all(departmentIds.flatMap((departmentId) => weekStarts.map(async (weekStart) => ({
    departmentId,
    weekStart,
    profileIds: await rpc("sadranim_of", { _dept: departmentId, _week: weekStart }),
  }))));
}
