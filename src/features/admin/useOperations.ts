import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/features/auth/useSession";
import { fetchCanManageOperations, fetchOperationalDepartments } from "./operationsApi";

export function useCanManageOperations(departmentId?: string) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["operations", "access", session?.user.id, departmentId],
    queryFn: () => fetchCanManageOperations(departmentId),
    enabled: !!session,
    staleTime: 60_000,
  });
}

export function useOperationalDepartments() {
  const { session } = useSession();
  return useQuery({
    queryKey: ["operations", "departments", session?.user.id],
    queryFn: fetchOperationalDepartments,
    enabled: !!session,
    staleTime: 60_000,
  });
}
