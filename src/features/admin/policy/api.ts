import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database, Json } from "@/integrations/supabase/types";
import type { FairnessRow } from "@/features/solverBridge/buildSolverInput";

/**
 * The only file in `admin/policy` that calls `supabase.from`/`.rpc`.
 * `policies` (the pointer row) is admin-writable directly; `policy_versions`
 * is immutable and only ever created via `create_policy_version` (assigns
 * `version_no` and repoints `policies.current_version_id`, DATA_MODEL.md
 * §3.4); activating a policy for its department is `set_policy_active`.
 */
export type PolicyRow = Database["public"]["Tables"]["policies"]["Row"];
export type PolicyVersionRow = Database["public"]["Tables"]["policy_versions"]["Row"];

export interface PolicyRuleConfig {
  type: string;
  weight: number;
  params: unknown;
}

export async function fetchPolicies(departmentId: string): Promise<PolicyRow[]> {
  const { data, error } = await supabase.from("policies").select("*").eq("department_id", departmentId).order("name", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

/**
 * `is_active: false` on purpose: `policies_one_active_idx` allows only one
 * active policy per department (DATA_MODEL.md §3.4) — a new
 * policy starts inactive and is switched on explicitly via
 * `he.action.activateForDept` / `setPolicyActive`, never by racing whatever
 * is already active for that scope.
 */
export async function createPolicy(input: { name: string; department_id: string }): Promise<PolicyRow> {
  const { data, error } = await supabase
    .from("policies")
    .insert({ name: input.name, department_id: input.department_id, is_active: false })
    .select()
    .single();
  if (error) throw toAppError(error);
  return data;
}

export async function fetchPolicyVersions(policyId: string): Promise<PolicyVersionRow[]> {
  const { data, error } = await supabase
    .from("policy_versions")
    .select("*")
    .eq("policy_id", policyId)
    .order("version_no", { ascending: false });
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function createPolicyVersion(policyId: string, rules: PolicyRuleConfig[], note: string | null): Promise<string> {
  return rpc("create_policy_version", {
    p_policy_id: policyId,
    p_rules: rules as unknown as Json,
    p_note: note ?? undefined,
  });
}

export async function setPolicyActive(policyId: string, isActive: boolean): Promise<void> {
  await rpc("set_policy_active", { p_policy_id: policyId, p_is_active: isActive });
}

/** Last week whose data is stable enough to preview against (`live` running or fully `archived`). */
export async function fetchLastTestableWeek(departmentId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("weeks")
    .select("week_start")
    .eq("department_id", departmentId)
    .in("phase", ["live", "archived"])
    .order("week_start", { ascending: false })
    .limit(1);
  if (error) throw toAppError(error);
  return data?.[0]?.week_start ?? null;
}

export type RequestRow = Database["public"]["Tables"]["requests"]["Row"];

/** All requests filed for one department/week (admin SELECT is open on `requests`, DATA_MODEL.md §4.3). */
export async function fetchWeekRequests(departmentId: string, weekStart: string): Promise<RequestRow[]> {
  const { data, error } = await supabase
    .from("requests")
    .select("*")
    .eq("department_id", departmentId)
    .eq("week_start", weekStart);
  if (error) throw toAppError(error);
  return data ?? [];
}

export async function fetchFairnessStats(
  departmentId: string,
  weekStart: string,
  lookbackWeeks: number,
): Promise<FairnessRow[]> {
  const { data, error } = await supabase.rpc("fairness_stats", {
    p_department_id: departmentId,
    p_week_start: weekStart,
    p_lookback_weeks: lookbackWeeks,
  });
  if (error) throw toAppError(error);
  return data ?? [];
}
