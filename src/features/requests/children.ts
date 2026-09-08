import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";

export interface ChildOption {
  id: string;
  name: string;
  /** A child assigned to the signed-in member is shown first, not forced. */
  isPriority: boolean;
}

export async function fetchChildren(departmentId: string, profileId: string): Promise<ChildOption[]> {
  const [{ data: children, error: childrenError }, { data: guardians, error: guardiansError }] = await Promise.all([
    supabase.from("children").select("id, full_name").eq("department_id", departmentId).order("full_name"),
    supabase.from("child_guardians").select("child_id").eq("profile_id", profileId),
  ]);
  if (childrenError) throw toAppError(childrenError);
  if (guardiansError) throw toAppError(guardiansError);
  const priority = new Set((guardians ?? []).map((guardian) => guardian.child_id));
  return (children ?? [])
    .map((child) => ({ id: child.id, name: child.full_name, isPriority: priority.has(child.id) }))
    .sort((a, b) => Number(b.isPriority) - Number(a.isPriority) || a.name.localeCompare(b.name, "he"));
}
