import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

export async function fetchCanManageOperations(departmentId?: string) {
  return rpc("can_manage_operations", departmentId ? { p_department_id: departmentId } : {});
}

/**
 * Departments the caller may manage operations for. With `departmentId` only that department is
 * checked (one RPC + one select; `canManage` lets a hook reuse its cached answer); without it,
 * every department is checked (one RPC each) — only the cross-department fetchers need that.
 */
export async function fetchOperationalDepartments(
  departmentId?: string,
  canManage: () => Promise<boolean> = () => fetchCanManageOperations(departmentId),
) {
  if (departmentId) {
    if (!(await canManage())) return [];
    const { data, error } = await supabase.from("departments").select("*").eq("id", departmentId).order("name");
    if (error) throw toAppError(error);
    return data ?? [];
  }
  const { data, error } = await supabase.from("departments").select("*").order("name");
  if (error) throw toAppError(error);
  const departments = data ?? [];
  const allowed = await Promise.all(departments.map((department) => fetchCanManageOperations(department.id)));
  return departments.filter((_, index) => allowed[index]);
}
