import { supabase } from "@/integrations/supabase/client";
import { ageFromBirthYear } from "@/lib/childAge";
import { rpc, toAppError } from "@/lib/rpc";

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

/** REQ §13.202: one "ride editors" link — whom I named (`person` = the editor) or who named me (`person` = the owner). */
export interface RideEditorLink {
  departmentId: string;
  person: { id: string; name: string };
}

export interface RideEditors {
  /** People I let edit my rides, in this department. */
  mine: RideEditorLink[];
  /** People who let me edit theirs. */
  grantedToMe: RideEditorLink[];
}

/** `ride_editors` rows where I am the owner or the editor (RLS shows only those). */
export async function fetchRideEditors(profileId: string): Promise<RideEditors> {
  const { data, error } = await supabase
    .from("ride_editors")
    .select("department_id, owner_id, editor_id, owner:profiles!ride_editors_owner_id_fkey(id, full_name), editor:profiles!ride_editors_editor_id_fkey(id, full_name)");
  if (error) throw toAppError(error);
  const rows = (data ?? []) as unknown as { department_id: string; owner_id: string; editor_id: string;
    owner: { id: string; full_name: string } | null; editor: { id: string; full_name: string } | null }[];
  const link = (departmentId: string, person: { id: string; full_name: string } | null): RideEditorLink[] =>
    person ? [{ departmentId, person: { id: person.id, name: person.full_name } }] : [];
  const byName = (a: RideEditorLink, b: RideEditorLink) => a.person.name.localeCompare(b.person.name, "he");
  return {
    mine: rows.filter((row) => row.owner_id === profileId).flatMap((row) => link(row.department_id, row.editor)).sort(byName),
    grantedToMe: rows.filter((row) => row.editor_id === profileId).flatMap((row) => link(row.department_id, row.owner)).sort(byName),
  };
}

/** The whole list of my editors in one department (adds tell the new editor once; removals are silent). */
export async function setRideEditors(departmentId: string, editorIds: readonly string[]): Promise<void> {
  await rpc("set_ride_editors", { p_department_id: departmentId, p_editor_ids: [...editorIds] });
}
