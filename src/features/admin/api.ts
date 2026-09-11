import { supabase } from "@/integrations/supabase/client";
import { rpc, toAppError } from "@/lib/rpc";

export async function fetchCanManageOperations(departmentId?: string) {
  return rpc("can_manage_operations", departmentId ? { p_department_id: departmentId } : {});
}

export async function fetchOperationalDepartments() {
  const { data, error } = await supabase.from("departments").select("*").order("name");
  if (error) throw toAppError(error);
  const departments = data ?? [];
  const allowed = await Promise.all(departments.map((department) => fetchCanManageOperations(department.id)));
  return departments.filter((_, index) => allowed[index]);
}
