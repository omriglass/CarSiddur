import { supabase } from "@/integrations/supabase/client";
import { phoneSchema } from "@/features/auth/schema";
import { he } from "@/i18n/he";
import { AppError, rpc, toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/**
 * The only file in `admin/members` that calls `supabase.from`/`.rpc`.
 * `profiles`/`department_members`/`member_invites` are admin-writable
 * directly (DATA_MODEL.md §4.3); `grant_admin` is RPC-only (no direct policy
 * for `is_admin`, protected by a trigger — revoking is a plain admin update,
 * which the same trigger allows for an admin actor).
 */
export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type DepartmentMember = Database["public"]["Tables"]["department_members"]["Row"];
export type MemberInvite = Database["public"]["Tables"]["member_invites"]["Row"];
export type Role = Database["public"]["Enums"]["role"];

export async function fetchAllProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").order("full_name", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchAllDepartmentMembers(): Promise<DepartmentMember[]> {
  const { data, error } = await supabase.from("department_members").select("*").is("removed_at", null);
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchMemberInvites(): Promise<MemberInvite[]> {
  const { data, error } = await supabase.from("member_invites").select("*");
  if (error) throw toAppError(error);
  return data ?? [];
}

/** `phone` is column-privilege-revoked from `authenticated` (DATA_MODEL.md §4.2) — read it through `phone_of()`. */
export async function fetchPhones(profileIds: string[]): Promise<Record<string, string | null>> {
  const entries = await Promise.all(
    profileIds.map(async (id) => {
      const { data, error } = await supabase.rpc("phone_of", { _profile: id });
      if (error) throw toAppError(error);
      return [id, data] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function approveMember(profileId: string, departmentId: string): Promise<void> {
  await rpc("admin_approve_member", { p_profile_id: profileId, p_department_id: departmentId });
}

export async function updateMemberDetails(profileId: string, fullName: string, phone: string, departmentId?: string): Promise<void> {
  let normalizedPhone = phone.trim();
  if (normalizedPhone && !/^\+[1-9][0-9]{7,14}$/.test(normalizedPhone)) {
    const parsed = phoneSchema.safeParse(normalizedPhone);
    if (!parsed.success) throw new AppError("unknown", he.onboarding.phoneInvalid);
    normalizedPhone = parsed.data;
  }
  await rpc("admin_update_member", { p_profile_id: profileId, p_details: {
    full_name: fullName, phone: normalizedPhone, ...(departmentId ? { department_id: departmentId } : {}),
  } });
}

export async function rejectMember(profileId: string): Promise<void> {
  const { error } = await supabase.from("profiles").update({ approval_status: "blocked" }).eq("id", profileId);
  if (error) throw toAppError(error);
}

export async function grantAdmin(profileId: string): Promise<void> {
  await rpc("grant_admin", { p_profile_id: profileId });
}

export async function revokeAdmin(profileId: string): Promise<void> {
  const { error } = await supabase.from("profiles").update({ is_admin: false }).eq("id", profileId);
  if (error) throw toAppError(error);
}

export async function setMemberRole(departmentId: string, profileId: string, role: Role): Promise<void> {
  const { error } = await supabase
    .from("department_members")
    .update({ role })
    .eq("department_id", departmentId)
    .eq("profile_id", profileId)
    .is("removed_at", null)
    .select("profile_id")
    .single();
  if (error) throw toAppError(error);
}

export async function addMemberToDepartment(departmentId: string, profileId: string, role: Role = "member"): Promise<void> {
  const { error } = await supabase
    .from("department_members")
    .upsert(
      { department_id: departmentId, profile_id: profileId, role, removed_at: null },
      { onConflict: "department_id,profile_id" },
    );
  if (error) throw toAppError(error);
}

export async function removeMemberFromDepartment(departmentId: string, profileId: string): Promise<void> {
  const { error } = await supabase
    .from("department_members")
    .update({ removed_at: new Date().toISOString() })
    .eq("department_id", departmentId)
    .eq("profile_id", profileId);
  if (error) throw toAppError(error);
}

export interface ImportRow {
  name: string;
  email: string;
}

export interface ImportResult {
  insertedInvites: number;
  updatedInvites: number;
  updatedProfiles: number;
}

/**
 * Imports the allow-list preview rows (UX_FLOWS.md §5.2): brand-new emails
 * become `member_invites` rows; emails that already match an unconsumed
 * invite or an existing profile just get their name updated, never
 * duplicated.
 */
export async function importAllowList(rows: ImportRow[], departmentId: string): Promise<ImportResult> {
  const emails = rows.map((r) => r.email.toLowerCase());
  const [profilesRes, invitesRes] = await Promise.all([
    supabase.from("profiles").select("id, email").in("email", emails),
    supabase.from("member_invites").select("id, email").in("email", emails),
  ]);
  if (profilesRes.error) throw toAppError(profilesRes.error);
  if (invitesRes.error) throw toAppError(invitesRes.error);

  const profileByEmail = new Map((profilesRes.data ?? []).map((p) => [p.email, p.id]));
  const inviteByEmail = new Map((invitesRes.data ?? []).map((i) => [i.email, i.id]));

  const toInsert: { email: string; full_name: string; department_id: string; role: Role }[] = [];
  const inviteUpdates: { id: string; full_name: string }[] = [];
  const profileUpdates: { id: string; full_name: string }[] = [];

  for (const row of rows) {
    const email = row.email.toLowerCase();
    const existingProfileId = profileByEmail.get(email);
    const existingInviteId = inviteByEmail.get(email);
    if (existingProfileId) {
      profileUpdates.push({ id: existingProfileId, full_name: row.name });
    } else if (existingInviteId) {
      inviteUpdates.push({ id: existingInviteId, full_name: row.name });
    } else {
      toInsert.push({ email, full_name: row.name, department_id: departmentId, role: "member" });
    }
  }

  if (toInsert.length > 0) {
    const { error } = await supabase.from("member_invites").insert(toInsert);
    if (error) throw toAppError(error);
  }
  for (const update of inviteUpdates) {
    const { error } = await supabase.from("member_invites").update({ full_name: update.full_name }).eq("id", update.id);
    if (error) throw toAppError(error);
  }
  for (const update of profileUpdates) {
    const { error } = await supabase.from("profiles").update({ full_name: update.full_name }).eq("id", update.id);
    if (error) throw toAppError(error);
  }

  return { insertedInvites: toInsert.length, updatedInvites: inviteUpdates.length, updatedProfiles: profileUpdates.length };
}
