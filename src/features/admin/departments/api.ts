import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

import type { Database } from "@/integrations/supabase/types";

/**
 * The only file in `admin/departments` that calls `supabase.from`. Direct
 * table writes (DATA_MODEL.md §4.3 policy matrix: `departments` and
 * `department_settings` are admin-writable directly, no RPC needed).
 */
export type Department = Database["public"]["Tables"]["departments"]["Row"];
export type DepartmentInsert = Database["public"]["Tables"]["departments"]["Insert"];
export type DepartmentUpdate = Database["public"]["Tables"]["departments"]["Update"];
export type DepartmentSettings = Database["public"]["Tables"]["department_settings"]["Row"];
export type DepartmentSettingsUpdate = Database["public"]["Tables"]["department_settings"]["Update"];

export async function fetchDepartments(): Promise<Department[]> {
  const { data, error } = await supabase.from("departments").select("*").order("name", { ascending: true });
  if (error) throw toAppError(error);
  return data ?? [];
}

/** Active member / car counts per department, for the list columns (UX_FLOWS.md §5.1). */
export async function fetchDepartmentCounts(): Promise<{
  members: Record<string, number>;
  cars: Record<string, number>;
}> {
  const [membersRes, carsRes] = await Promise.all([
    supabase.from("department_members").select("department_id").is("removed_at", null),
    supabase.from("cars").select("department_id").neq("status", "retired"),
  ]);
  if (membersRes.error) throw toAppError(membersRes.error);
  if (carsRes.error) throw toAppError(carsRes.error);

  const members: Record<string, number> = {};
  for (const row of membersRes.data ?? []) members[row.department_id] = (members[row.department_id] ?? 0) + 1;
  const cars: Record<string, number> = {};
  for (const row of carsRes.data ?? []) cars[row.department_id] = (cars[row.department_id] ?? 0) + 1;
  return { members, cars };
}

export async function createDepartment(input: DepartmentInsert & { source_department_id?: string }): Promise<Department> {
  const department = await rpc("create_department", { p_name: input.name, p_slug: input.slug,
    ...(input.source_department_id ? { p_source_department_id: input.source_department_id } : {}) });
  if (input.is_active === false) return updateDepartment(department.id, { is_active: false });
  return department;
}

export async function updateDepartment(id: string, patch: DepartmentUpdate): Promise<Department> {
  const { data, error } = await supabase.from("departments").update(patch).eq("id", id).select().single();
  if (error) throw toAppError(error);
  return data;
}

export async function fetchDepartmentSettings(departmentId: string): Promise<DepartmentSettings> {
  const { data, error } = await supabase
    .from("department_settings")
    .select("*")
    .eq("department_id", departmentId)
    .single();
  if (error) throw toAppError(error);
  return data;
}

export async function updateDepartmentSettings(
  departmentId: string,
  patch: DepartmentSettingsUpdate,
): Promise<DepartmentSettings> {
  const { data, error } = await supabase
    .from("department_settings")
    .update(patch)
    .eq("department_id", departmentId)
    .select()
    .single();
  if (error) throw toAppError(error);
  return data;
}
