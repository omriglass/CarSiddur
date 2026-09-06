import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/**
 * The only file in `admin/roster` that calls `supabase.from`.
 * `sadran_assignments` is admin-writable directly (DATA_MODEL.md §4.3).
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

/** Replaces the explicit roster for one (department, week) with `profileIds`. */
export async function setWeekAssignments(departmentId: string, weekStart: string, profileIds: string[]): Promise<void> {
  const del = await supabase
    .from("sadran_assignments")
    .delete()
    .eq("department_id", departmentId)
    .eq("week_start", weekStart);
  if (del.error) throw toAppError(del.error);
  if (profileIds.length === 0) return;
  const ins = await supabase
    .from("sadran_assignments")
    .insert(profileIds.map((profile_id) => ({ department_id: departmentId, profile_id, week_start: weekStart })));
  if (ins.error) throw toAppError(ins.error);
}

/** Replaces the standing default (`week_start is null`) roster for one department. */
export async function setStandingDefault(departmentId: string, profileIds: string[]): Promise<void> {
  const del = await supabase
    .from("sadran_assignments")
    .delete()
    .eq("department_id", departmentId)
    .is("week_start", null);
  if (del.error) throw toAppError(del.error);
  if (profileIds.length === 0) return;
  const ins = await supabase
    .from("sadran_assignments")
    .insert(profileIds.map((profile_id) => ({ department_id: departmentId, profile_id, week_start: null })));
  if (ins.error) throw toAppError(ins.error);
}
