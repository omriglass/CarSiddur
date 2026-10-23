import { supabase } from "@/integrations/supabase/client";

import type { SeqRow } from "./watcher";

/**
 * The only file in the `liveSync` feature that talks to Supabase (REQ item 149, ARCHITECTURE.md §12.1).
 * `week_change_seqs` is SECURITY INVOKER: RLS on the counter tables decides, an unauthorised caller reads zeros.
 */
export async function fetchWeekChangeSeqs(departmentId: string, weeks: readonly string[]): Promise<SeqRow[]> {
  const { data, error } = await supabase.rpc("week_change_seqs", { p_department_id: departmentId, p_weeks: [...weeks] });
  // Deliberately not `toAppError`/a toast: a failed check is silent, the next one (or the focus refetch) catches up.
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    weekStart: row.week_start,
    seq: Number(row.seq),
    publicSeq: Number(row.public_seq),
    deptSeq: Number(row.dept_seq),
  }));
}
