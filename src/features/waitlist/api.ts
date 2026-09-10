import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import { waitlistGroupRowSchema } from "./schema";
import type { WaitlistGroup } from "./types";

/**
 * Contested waiting-list groups (REQ §13.75, DATA_MODEL.md §7.4a). This is
 * the only file in the `waitlist` feature that calls `supabase.from()`/
 * `.rpc()` (CLAUDE.md "Structure").
 */
export async function fetchWaitlistGroups(departmentId: string, weekStart: string): Promise<WaitlistGroup[]> {
  const { data, error } = await supabase
    .from("v_waitlist_groups")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart)
    .eq("status", "open");
  if (error) throw toAppError(error);
  return (data ?? []).map((row) => waitlistGroupRowSchema.parse(row));
}

export interface ResolveWaitlistGroupResult {
  group_id: string;
  ride_id: string;
  car_id: string;
  driver_request_id: string;
  chosen: string[];
  not_chosen: string[];
}

/** `p_request_ids[0]` is the driver (DATA_MODEL.md §7.4a). */
export async function resolveWaitlistGroup(groupId: string, requestIds: string[], expectedVersion: number): Promise<ResolveWaitlistGroupResult> {
  const result = await rpc("resolve_waitlist_group", {
    p_group_id: groupId,
    p_request_ids: requestIds,
    p_expected_version: expectedVersion,
  });
  return result as unknown as ResolveWaitlistGroupResult;
}

/** Sadran-only: drops the group, every member stays `waitlisted`/`WAITLISTED_NO_CAR`. */
export async function cancelWaitlistGroup(groupId: string, expectedVersion: number): Promise<void> {
  await rpc("cancel_waitlist_group", { p_group_id: groupId, p_expected_version: expectedVersion });
}
