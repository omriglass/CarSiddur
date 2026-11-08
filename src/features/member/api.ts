import { supabase } from "@/integrations/supabase/client";
import { ageFromBirthYear } from "@/lib/childAge";
import { toAppError } from "@/lib/rpc";

export interface GuardedChild {
  id: string;
  name: string;
  /** Null without a recorded birth year. */
  age: number | null;
}

/** Children I am a guardian of, across all my departments (`child_guardians` rows are readable by their own guardian — RLS). */
export async function fetchGuardedChildren(profileId: string, referenceYear = new Date().getFullYear()): Promise<GuardedChild[]> {
  const { data, error } = await supabase
    .from("child_guardians")
    .select("child_id, child:children!child_guardians_child_id_fkey(id, full_name, birth_year)")
    .eq("profile_id", profileId);
  if (error) throw toAppError(error);
  return (data ?? [])
    .flatMap((row) => (row.child ? [row.child] : []))
    .map((child) => ({ id: child.id, name: child.full_name, age: ageFromBirthYear(child.birth_year, referenceYear) }))
    .sort((a, b) => a.name.localeCompare(b.name, "he"));
}
