import { z } from "zod";

import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

/**
 * "הצג מדיניות" (REQ §13.133): the only file in `policyView` calling `supabase.from`/`.rpc`. Members read
 * their department's policies and versions directly (RLS `policies_select`/`policy_versions_select`:
 * `member_of`); the week alignment is an aggregate-only RPC (`policy_week_alignment`, DATA_MODEL §3.9).
 */
export interface ViewRule {
  type: string;
  weight: number;
  params: unknown;
}

export interface ViewPolicy {
  id: string;
  name: string;
  isActive: boolean;
  versionNo: number | null;
  rules: ViewRule[];
}

const ruleSchema = z.object({ type: z.string(), weight: z.number(), params: z.unknown() });

export async function fetchDepartmentPolicies(departmentId: string): Promise<ViewPolicy[]> {
  const { data: policies, error } = await supabase
    .from("policies")
    .select("id, name, is_active, current_version_id")
    .eq("department_id", departmentId)
    .order("name", { ascending: true });
  if (error) throw toAppError(error);
  const versionIds = (policies ?? []).flatMap((p) => (p.current_version_id ? [p.current_version_id] : []));
  const versions = new Map<string, { version_no: number; rules: unknown }>();
  if (versionIds.length) {
    const { data, error: versionError } = await supabase.from("policy_versions").select("id, version_no, rules").in("id", versionIds);
    if (versionError) throw toAppError(versionError);
    for (const row of data ?? []) versions.set(row.id, row);
  }
  return (policies ?? []).map((p) => {
    const version = p.current_version_id ? versions.get(p.current_version_id) : undefined;
    const parsed = z.array(ruleSchema).safeParse(version?.rules ?? []);
    return {
      id: p.id,
      name: p.name,
      isActive: p.is_active,
      versionNo: version?.version_no ?? null,
      rules: parsed.success ? parsed.data.filter((rule) => rule.weight > 0).map((rule) => ({ ...rule, params: rule.params ?? {} })) : [],
    };
  });
}

const alignmentSchema = z.object({
  week_start: z.string(),
  pairs: z.number(),
  followed: z.number(),
  reversed: z.number(),
  tied: z.number(),
}).nullable();

export type PolicyAlignment = { weekStart: string; pairs: number; followed: number; reversed: number; tied: number } | null;

export async function fetchPolicyAlignment(policyId: string): Promise<PolicyAlignment> {
  const raw = alignmentSchema.parse(await rpc("policy_week_alignment", { p_policy_id: policyId }));
  return raw ? { weekStart: raw.week_start, pairs: raw.pairs, followed: raw.followed, reversed: raw.reversed, tied: raw.tied } : null;
}
