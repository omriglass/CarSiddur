import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useQuery } from "@tanstack/react-query";

import { fetchOpenAndLiveWeekStarts } from "@/features/siddur/api";

import { fetchCanManageWeek } from "./api";
import { authKeys } from "./queryKeys";
import { useMyDepartments } from "./useMyDepartments";
import { useSession } from "./useSession";

interface IsSadranResult {
  isSadran: boolean;
  isLoading: boolean;
}

/** Board authorization: permanent department Sadrans, admins, or this week's assignee. */
export function useIsSadran(
  departmentId: string | undefined,
  weekStart: string | undefined,
): IsSadranResult {
  const { session } = useSession();
  const profileId = session?.user.id;

  const query = useQuery({
    queryKey: authKeys.isSadran(profileId, departmentId ?? "", weekStart ?? ""),
    queryFn: () => fetchCanManageWeek(departmentId as string, weekStart as string),
    enabled: !!profileId && !!departmentId && !!weekStart,
    staleTime: 60_000,
  });

  return {
    isSadran: !!profileId && (query.data ?? false),
    isLoading: query.isLoading,
  };
}

/**
 * Whether I am Sadran of any of my departments for their currently open or
 * live weeks (UX_FLOWS.md §2.2: "while assigned to at least one
 * department/week" a fifth bottom tab, סדרן, appears). Used by `AppShell`.
 */
export function useIsSadranAnywhere(): IsSadranResult {
  const { session } = useSession();
  const profileId = session?.user.id;
  const departmentsQuery = useMyDepartments();
  const active = useActiveDepartment();
  const departmentIds = active.departmentId ? [active.departmentId] : [];

  const query = useQuery({
    queryKey: authKeys.isSadranAnywhere(profileId, departmentIds),
    queryFn: async () => {
      const weekStartsByDept = await Promise.all(
        departmentIds.map((departmentId) => fetchOpenAndLiveWeekStarts(departmentId)),
      );
      const pairs = departmentIds.flatMap((departmentId, index) =>
        (weekStartsByDept[index] ?? []).map((weekStart) => ({ departmentId, weekStart })),
      );
      const permissions = await Promise.all(
        pairs.map((pair) => fetchCanManageWeek(pair.departmentId, pair.weekStart)),
      );
      return permissions.some(Boolean);
    },
    enabled: !!profileId && departmentsQuery.isSuccess && !!active.departmentId,
    staleTime: 60_000,
  });

  return {
    isSadran: query.data ?? false,
    isLoading: active.isLoading || departmentsQuery.isLoading || query.isLoading,
  };
}
