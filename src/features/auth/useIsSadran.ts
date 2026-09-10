import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useQuery } from "@tanstack/react-query";

import { fetchCanManageAnyOpenWeek, fetchCanManageWeek } from "./api";
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
    // One RPC (`can_manage_any_open_week`) instead of fetching every
    // open/live week start and then one `can_manage_week` per week
    // (docs/HARDENING_2026-09.md §3 item 4) — same open/solving/published/live
    // + permanent-operations-rights semantics, computed server-side.
    queryFn: () => fetchCanManageAnyOpenWeek(active.departmentId as string),
    enabled: !!profileId && departmentsQuery.isSuccess && !!active.departmentId,
    staleTime: 60_000,
  });

  return {
    isSadran: query.data ?? false,
    isLoading: active.isLoading || departmentsQuery.isLoading || query.isLoading,
  };
}
