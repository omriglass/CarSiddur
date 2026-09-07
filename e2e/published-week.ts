import { createClient } from "@supabase/supabase-js";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, SUPABASE_URL, SUPABASE_ANON_KEY } from "./helpers";

/** Publish an empty future fixture before adding live rides; respects immutable snapshots. */
export async function publishedFixtureWeek(week: string) {
  const service = serviceRoleClient();
  const admin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: authError } = await admin.auth.signInWithPassword(SEEDED_USERS.admin);
  if (authError) throw authError;
  const { data: existing, error: readError } = await service.from("weeks").select("phase")
    .eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).maybeSingle();
  if (readError) throw readError;
  if (!existing) {
    const at = (daysBefore: number) => new Date(Date.parse(`${week}T00:00:00Z`) - daysBefore * 86400000).toISOString();
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: week,
      phase: "open", open_at: at(7), close_at: at(3), publish_at: at(2) });
    if (error) throw error;
  }
  if (existing?.phase !== "published") {
    const { data: policies, error: policyError } = await service.from("policies").select("id,current_version_id,name")
      .or(`department_id.eq.${NEVO_DEPARTMENT_ID},department_id.is.null`).not("current_version_id", "is", null);
    if (policyError) throw policyError;
    const args = { p_department_id: NEVO_DEPARTMENT_ID, p_week_start: week };
    const { data: fingerprint, error: fingerprintError } = await admin.rpc("publish_scores_fingerprint", args);
    if (fingerprintError) throw fingerprintError;
    const { error } = await admin.rpc("publish_siddur", { ...args, p_expected_fingerprint: fingerprint, p_profile_scores: [],
      p_policy_scores: policies!.map((policy) => ({ policy_id: policy.id, policy_version_id: policy.current_version_id, policy_name: policy.name,
        request_count: 0, served_count: 0, priority_total: 0, served_priority_total: 0, alignment_ratio: null, profiles: [] })) });
    if (error) throw error;
  }
  return admin;
}
