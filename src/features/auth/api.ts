import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";
import type { Role } from "@/lib/enums";

/**
 * The only file in the `auth` feature that calls `supabase.from`/`.rpc`
 * (CLAUDE.md Conventions, ui-dev.md "Structure").
 */
export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type ProfilePatch = Partial<
  Pick<
    Profile,
    | "full_name"
    | "display_name"
    | "phone"
    | "default_department_id"
    | "home_week_preference"
    | "muted_events"
    | "does_not_drive"
  >
>;

/**
 * `profiles.phone` is not directly selectable (RLS); the caller's own phone is fetched
 * separately via `phone_of(uuid)` and merged in, so `Profile` (which still declares
 * `phone`) stays satisfied.
 */
const PROFILE_COLUMNS_WITHOUT_PHONE =
  "approval_status, approved_at, approved_by, avatar_url, created_at, default_boosters, default_child_seats, default_department_id, display_name, does_not_drive, email, full_name, google_name, home_week_preference, id, is_admin, muted_events, updated_at";

type ProfileWithoutPhone = Omit<Profile, "phone">;

export async function fetchProfile(profileId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS_WITHOUT_PHONE)
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw toAppError(error);
  if (!data) return null;
  const phone = await rpc("phone_of", { _profile: profileId });
  return { ...(data as ProfileWithoutPhone), phone };
}

export async function updateProfile(profileId: string, patch: ProfilePatch): Promise<Profile> {
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", profileId)
    .select(PROFILE_COLUMNS_WITHOUT_PHONE)
    .single();
  if (error) throw toAppError(error);
  const phone = await rpc("phone_of", { _profile: profileId });
  return { ...(data as ProfileWithoutPhone), phone };
}

export interface DepartmentMembership {
  department_id: string;
  role: Role;
  /** REQ §13.93: the member's fixed origin for this department (`set_my_default_origin`), null = department home. */
  default_origin_id: string | null;
  department: { id: string; name: string; slug: string };
}

/** `department_members` joined to `departments`, active memberships only. */
export async function fetchMyDepartments(profileId: string): Promise<DepartmentMembership[]> {
  const { data, error } = await supabase
    .from("department_members")
    .select("department_id, role, default_origin_id, department:departments(id, name, slug)")
    .eq("profile_id", profileId)
    .is("removed_at", null);
  if (error) throw toAppError(error);
  return (data ?? []) as unknown as DepartmentMembership[];
}

/** "נקודת יציאה קבועה" (REQ §13.93, ORIGINS_PLAN §2.3) — null clears it (department home). */
export async function setMyDefaultOrigin(departmentId: string, originId: string | null): Promise<void> {
  // `p_origin_id uuid default null` — the generated Args type doesn't know the SQL param
  // accepts null (it only reflects the column type), so this cast matches the real signature.
  await rpc("set_my_default_origin", { p_department_id: departmentId, p_origin_id: originId as unknown as string });
}

export interface DepartmentMemberOption {
  id: string;
  name: string;
  /** REQ §13.93/§13.88: whether this companion can drive (`profiles.does_not_drive`). */
  doesNotDrive: boolean;
  /** R4U5: `department_members.default_origin_id` (null = the department home). */
  homeOriginId?: string | null;
}

/** Active members of a department (for `CompanionPicker`), excluding the current member. */
export async function fetchDepartmentMembers(
  departmentId: string,
  excludeProfileId: string,
): Promise<DepartmentMemberOption[]> {
  const { data, error } = await supabase
    .from("department_members")
    .select("profile_id, default_origin_id, profile:profiles!department_members_profile_id_fkey(id, full_name, does_not_drive)")
    .eq("department_id", departmentId)
    .is("removed_at", null)
    .neq("profile_id", excludeProfileId);
  if (error) throw toAppError(error);
  return ((data ?? []) as unknown as { profile_id: string; default_origin_id: string | null; profile: { id: string; full_name: string; does_not_drive: boolean } | null }[])
    .filter((row) => row.profile !== null)
    .map((row) => ({ id: row.profile_id, name: row.profile!.full_name, doesNotDrive: row.profile!.does_not_drive, homeOriginId: row.default_origin_id }));
}

/** Duty recipients for a week: explicit assignment or permanent Sadran rotation. */
export async function fetchSadranimOf(departmentId: string, weekStart: string): Promise<string[]> {
  return rpc("sadranim_of", { _dept: departmentId, _week: weekStart });
}

/** Server authorization includes permanent Sadrans even when somebody else is on duty. */
export async function fetchCanManageWeek(departmentId: string, weekStart: string): Promise<boolean> {
  return rpc("can_manage_week", { _dept: departmentId, _week: weekStart });
}

/**
 * Whether I can manage *some* open/solving/published/live week of this
 * department (or hold permanent operations rights there) — one RPC instead
 * of `useIsSadranAnywhere`'s old "fetch every open/live week start, then one
 * `can_manage_week` per week" waterfall (docs/HARDENING_2026-09.md §3 item 4).
 */
export async function fetchCanManageAnyOpenWeek(departmentId: string): Promise<boolean> {
  return rpc("can_manage_any_open_week", { p_department_id: departmentId });
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
