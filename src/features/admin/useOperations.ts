import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/features/auth/useSession";
import { fetchCanManageOperations, fetchOperationalDepartments } from "./api";
import { operationsKeys } from "./queryKeys";

export function useCanManageOperations(departmentOverride?: string) {
  const active = useActiveDepartment();
  const departmentId = departmentOverride ?? active.departmentId;
  const { session } = useSession();
  const query = useQuery({
    queryKey: operationsKeys.access(session?.user.id, departmentId),
    queryFn: () => fetchCanManageOperations(departmentId),
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
    // Shares the `useCanManageOperations` cache entry instead of asking the server a second time.
    queryFn: () => fetchOperationalDepartments(departmentId as string, () => queryClient.ensureQueryData({
      queryKey: operationsKeys.access(session?.user.id, departmentId),
      queryFn: () => fetchCanManageOperations(departmentId),
    })),
    enabled: !!session && !!departmentId,
  });
}
