import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/rpc";
import { ageFromBirthYear, isAdultPassenger } from "@/lib/childAge";

export interface ChildOption {
  id: string;
  name: string;
  birthYear: number | null;
  age: number | null;
  isAdultPassenger: boolean;
  /** A child assigned to the signed-in member is shown first, not forced. */
  isPriority: boolean;
}

export async function fetchChildren(departmentId: string, profileId: string, referenceYear = new Date().getFullYear()): Promise<ChildOption[]> {
  const [{ data: children, error: childrenError }, { data: guardians, error: guardiansError }] = await Promise.all([
    supabase.from("children").select("id, full_name, birth_year").eq("department_id", departmentId).order("full_name"),
    supabase.from("child_guardians").select("child_id").eq("profile_id", profileId),
  ]);
  if (childrenError) throw toAppError(childrenError);
  if (guardiansError) throw toAppError(guardiansError);
  const priority = new Set((guardians ?? []).map((guardian) => guardian.child_id));
  return (children ?? [])
    .map((child) => ({
      id: child.id,
      name: child.full_name,
      birthYear: child.birth_year,
      age: ageFromBirthYear(child.birth_year, referenceYear),
      isAdultPassenger: isAdultPassenger(child.birth_year, referenceYear),
      isPriority: priority.has(child.id),
    }))
    .sort((a, b) => Number(b.isPriority) - Number(a.isPriority) || a.name.localeCompare(b.name, "he"));
}
