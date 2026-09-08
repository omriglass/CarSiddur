import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/features/auth/useSession";
import { fetchCanManageOperations, fetchOperationalDepartments } from "./operationsApi";

export function useCanManageOperations(departmentOverride?: string) {
  const active = useActiveDepartment();
  const departmentId = departmentOverride ?? active.departmentId;
  const { session } = useSession();
  const query = useQuery({
    queryKey: ["operations", "access", session?.user.id, departmentId],
    queryFn: () => fetchCanManageOperations(departmentId),
    enabled: !!session && !!departmentId,
    staleTime: 60_000,
  });
  return { ...query, isLoading: active.isLoading || query.isLoading };
}

export function useOperationalDepartments() {
  const { departmentId } = useActiveDepartment();
  const { session } = useSession();
  return useQuery({
    queryKey: ["operations", "departments", session?.user.id, departmentId],
    queryFn: async () => (await fetchOperationalDepartments()).filter((department) => department.id === departmentId),
    enabled: !!session && !!departmentId,
    staleTime: 60_000,
  });
}
