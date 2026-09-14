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
    // Scores are a reporting snapshot, never a publication precondition (publish_siddur:
    // "a missing or unavailable score calculation must never prevent publication"). Pass NO
    // score arrays: a policy entry with an empty `profiles` list is rejected by
    // `assert_publication_scores` as soon as the week has any open request (found 2026-09-14
    // when one-way-consent started publishing after its requests exist).
    const args = { p_department_id: NEVO_DEPARTMENT_ID, p_week_start: week };
    const { data: fingerprint, error: fingerprintError } = await admin.rpc("publish_scores_fingerprint", args);
    if (fingerprintError) throw fingerprintError;
    const { error } = await admin.rpc("publish_siddur", { ...args, p_expected_fingerprint: fingerprint, p_profile_scores: [], p_policy_scores: [] });
    if (error) throw error;
  }
  return admin;
}
