import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { departmentAccessQuery } from "@/features/auth/useIsSadran";
import { useSession } from "@/features/auth/useSession";
import { fetchOperationalDepartments } from "./api";
import { operationsKeys } from "./queryKeys";

/** `can_manage_operations` for the department, read from the shared access entry (`my_department_access`, PF1 DC2a). */
export function useCanManageOperations(departmentOverride?: string) {
  const active = useActiveDepartment();
  const departmentId = departmentOverride ?? active.departmentId;
  const { session } = useSession();
  const query = useQuery({
    ...departmentAccessQuery(session?.user.id, departmentId),
    select: (access) => access.operations,
    enabled: !!session && !!departmentId,
  });
  return { ...query, isLoading: active.isLoading || query.isLoading };
}

export function useOperationalDepartments() {
  const { departmentId } = useActiveDepartment();
  const { session } = useSession();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: operationsKeys.departments(session?.user.id, departmentId),
    // Shares the access cache entry instead of asking the server a second time.
    queryFn: () => fetchOperationalDepartments(departmentId as string, async () =>
      (await queryClient.ensureQueryData(departmentAccessQuery(session?.user.id, departmentId))).operations),
    enabled: !!session && !!departmentId,
  });
}
