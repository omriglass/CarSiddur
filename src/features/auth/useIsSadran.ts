import { useQuery } from "@tanstack/react-query";

import { fetchOpenAndLiveWeekStarts } from "@/features/siddur/api";

import { fetchSadranimOf } from "./api";
import { authKeys } from "./queryKeys";
import { useMyDepartments } from "./useMyDepartments";
import { useSession } from "./useSession";

interface IsSadranResult {
  isSadran: boolean;
  isLoading: boolean;
}

/**
 * Whether I am Sadran of `(departmentId, weekStart)` — explicit
 * `sadran_assignments` rows for that week if any exist, otherwise the
 * standing default (DATA_MODEL.md §3.1). Delegates to the `sadranim_of` RPC
 * so the client never reimplements that resolution rule.
 */
export function useIsSadran(
  departmentId: string | undefined,
  weekStart: string | undefined,
): IsSadranResult {
  const { session } = useSession();
  const profileId = session?.user.id;

  const query = useQuery({
    queryKey: authKeys.isSadran(profileId, departmentId ?? "", weekStart ?? ""),
    queryFn: () => fetchSadranimOf(departmentId as string, weekStart as string),
    enabled: !!profileId && !!departmentId && !!weekStart,
    staleTime: 60_000,
  });

  return {
    isSadran: !!profileId && (query.data?.includes(profileId) ?? false),
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
  const departmentIds = (departmentsQuery.data ?? []).map((d) => d.department_id);

  const query = useQuery({
    queryKey: authKeys.isSadranAnywhere(profileId, departmentIds),
    queryFn: async () => {
      const weekStartsByDept = await Promise.all(
        departmentIds.map((departmentId) => fetchOpenAndLiveWeekStarts(departmentId)),
      );
      const pairs = departmentIds.flatMap((departmentId, index) =>
        (weekStartsByDept[index] ?? []).map((weekStart) => ({ departmentId, weekStart })),
      );
      const sadranLists = await Promise.all(
        pairs.map((pair) => fetchSadranimOf(pair.departmentId, pair.weekStart)),
      );
      return sadranLists.some((ids) => profileId !== undefined && ids.includes(profileId));
    },
    enabled: !!profileId && departmentsQuery.isSuccess,
    staleTime: 60_000,
  });

  return {
    isSadran: query.data ?? false,
    isLoading: departmentsQuery.isLoading || query.isLoading,
  };
}
