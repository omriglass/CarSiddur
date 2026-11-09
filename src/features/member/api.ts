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
  /** On the list (`ride_editors`); a co-parent who was also named is both. */
  named: boolean;
  /** REQ §13.202 (i): through a child we share — not removable, nothing sent. */
  coParent: boolean;
}

export interface RideEditors {
  /** People I let edit my rides, in this department. */
  mine: RideEditorLink[];
  /** People who let me edit theirs. */
  grantedToMe: RideEditorLink[];
}

/** My editor links both ways (`my_ride_editor_links`): the people I named or share a child with, and those who named me or share one. */
export async function fetchRideEditors(): Promise<RideEditors> {
  const rows = await rpc("my_ride_editor_links", undefined as never);
  const link = (row: (typeof rows)[number]): RideEditorLink => ({
    departmentId: row.department_id, person: { id: row.person_id, name: row.person_name }, named: row.named, coParent: row.co_parent,
  });
  const byName = (a: RideEditorLink, b: RideEditorLink) => a.person.name.localeCompare(b.person.name, "he");
  return {
    mine: (rows ?? []).filter((row) => row.direction === "mine").map(link).sort(byName),
    grantedToMe: (rows ?? []).filter((row) => row.direction === "granted").map(link).sort(byName),
  };
}

/** The whole list of my editors in one department (adds tell the new editor once; removals are silent). */
export async function setRideEditors(departmentId: string, editorIds: readonly string[]): Promise<void> {
  await rpc("set_ride_editors", { p_department_id: departmentId, p_editor_ids: [...editorIds] });
}
