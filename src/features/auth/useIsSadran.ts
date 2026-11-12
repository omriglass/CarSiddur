import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { type QueryClient, useQuery } from "@tanstack/react-query";

import { canManageWeek, type DepartmentAccess, fetchDepartmentAccess } from "./api";
import { authKeys } from "./queryKeys";
import { useMyDepartments } from "./useMyDepartments";
import { useSession } from "./useSession";

interface IsSadranResult {
  isSadran: boolean;
  isLoading: boolean;
}

/** The one cache entry behind every "may I manage here" answer (PF1 DC2a). */
export function departmentAccessQuery(profileId: string | undefined, departmentId: string | undefined) {
  return {
    queryKey: authKeys.departmentAccess(profileId, departmentId),
    queryFn: () => fetchDepartmentAccess(departmentId as string),
  };
}

/** Imperative read (cached like the hooks): what the signed-in person may manage in a department. */
export function fetchDepartmentAccessCached(
  queryClient: QueryClient, profileId: string | undefined, departmentId: string,
): Promise<DepartmentAccess> {
  return queryClient.fetchQuery(departmentAccessQuery(profileId, departmentId));
}

export function useDepartmentAccess(departmentId: string | undefined, enabled = true) {
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({ ...departmentAccessQuery(profileId, departmentId), enabled: enabled && !!profileId && !!departmentId });
}

/** Board authorization: permanent department Sadrans, admins, or this week's assignee. */
export function useIsSadran(
  departmentId: string | undefined,
  weekStart: string | undefined,
): IsSadranResult {
  const query = useDepartmentAccess(departmentId, !!weekStart);
  return {
    isSadran: canManageWeek(query.data, weekStart),
    isLoading: query.isLoading,
  };
}

/**
 * Whether I am Sadran of the active department for its currently open or
 * live weeks (UX_FLOWS.md §2.2: "while assigned to at least one
 * department/week" a fifth bottom tab, סדרן, appears). Used by `AppShell`.
 */
export function useIsSadranAnywhere(): IsSadranResult {
  const departmentsQuery = useMyDepartments();
  const active = useActiveDepartment();
  const query = useDepartmentAccess(active.departmentId, departmentsQuery.isSuccess);

  return {
    isSadran: query.data?.anyOpenWeek ?? false,
    isLoading: active.isLoading || departmentsQuery.isLoading || query.isLoading,
  };
}
