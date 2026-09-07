import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/**
 * The only file in the `auth` feature that calls `supabase.from`/`.rpc`
 * (CLAUDE.md Conventions, ui-dev.md "Structure").
 */
export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type ProfilePatch = Partial<
  Pick<
    Profile,
    "full_name" | "phone" | "default_department_id" | "home_week_preference" | "muted_events"
  >
>;

export async function fetchProfile(profileId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw toAppError(error);
  return data;
}

export async function updateProfile(profileId: string, patch: ProfilePatch): Promise<Profile> {
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", profileId)
    .select("*")
    .single();
  if (error) throw toAppError(error);
  return data;
}

export interface DepartmentMembership {
  department_id: string;
  role: Database["public"]["Enums"]["role"];
  department: { id: string; name: string; slug: string };
}

/** `department_members` joined to `departments`, active memberships only. */
export async function fetchMyDepartments(profileId: string): Promise<DepartmentMembership[]> {
  const { data, error } = await supabase
    .from("department_members")
    .select("department_id, role, department:departments(id, name, slug)")
    .eq("profile_id", profileId)
    .is("removed_at", null);
  if (error) throw toAppError(error);
  return (data ?? []) as unknown as DepartmentMembership[];
}

export interface DepartmentMemberOption {
  id: string;
  name: string;
}

/** Active members of a department (for `CompanionPicker`), excluding the current member. */
export async function fetchDepartmentMembers(
  departmentId: string,
  excludeProfileId: string,
): Promise<DepartmentMemberOption[]> {
  const { data, error } = await supabase
    .from("department_members")
    .select("profile_id, profile:profiles!department_members_profile_id_fkey(id, full_name)")
    .eq("department_id", departmentId)
    .is("removed_at", null)
    .neq("profile_id", excludeProfileId);
  if (error) throw toAppError(error);
  return ((data ?? []) as unknown as { profile_id: string; profile: { id: string; full_name: string } | null }[])
    .filter((row) => row.profile !== null)
    .map((row) => ({ id: row.profile_id, name: row.profile!.full_name }));
}

/**
 * Profile ids who are Sadran of `(departmentId, weekStart)` — explicit rows
 * for that week if any exist, otherwise the standing default
 * (`sadran_assignments.week_start is null`); mirrors the SQL `is_sadran()`
 * resolution rule exactly since it calls the same `sadranim_of()` function
 * (DATA_MODEL.md §3.1, §4.2) rather than reimplementing it client-side.
 */
export async function fetchSadranimOf(departmentId: string, weekStart: string): Promise<string[]> {
  return rpc("sadranim_of", { _dept: departmentId, _week: weekStart });
}

export async function registerPushSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}): Promise<string> {
  return rpc("register_push_subscription", {
    p_endpoint: input.endpoint,
    p_p256dh: input.p256dh,
    p_auth: input.auth,
    p_user_agent: input.userAgent,
  });
}

/**
 * No RPC exists for removing a push subscription (only `register_push_subscription`,
 * DATA_MODEL §3.11) — `push_subscriptions_delete` RLS lets a member delete their own
 * row directly (`profile_id = auth.uid()`), so `src/lib/push.ts` unsubscribes this way.
 */
export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) throw toAppError(error);
}

/** Whether the signed-in member has at least one push subscription row (Profile push status). */
export async function fetchMyPushSubscriptionCount(profileId: string): Promise<number> {
  const { count, error } = await supabase
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId);
  if (error) throw toAppError(error);
  return count ?? 0;
}
