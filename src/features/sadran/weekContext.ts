import { useQuery } from "@tanstack/react-query";

import { fetchCanManageWeek } from "@/features/auth/api";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useSession } from "@/features/auth/useSession";
import { fetchWeeks } from "@/features/siddur/api";

import { sadranKeys } from "./keys";

export interface DefaultSadranWeek {
  departmentId: string;
  weekStart: string;
}

/** Prefer the next request window, then work in progress, then the live board. */
const PHASE_PRIORITY: Record<string, number> = { open: 0, solving: 1, published: 2, live: 3 };

/**
 * Resolves which `(departmentId, weekStart)` the bare `/sadran` route should
 * redirect to: the first department I'm Sadran of, preferring its currently
 * open or in-progress week over a live one. Mirrors `useIsSadranAnywhere`'s resolution
 * (`can_manage_week` RPC) rather than reimplementing it.
 */
export function useDefaultSadranWeek() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const departmentsQuery = useMyDepartments();
  const departmentIds = (departmentsQuery.data ?? []).map((d) => d.department_id);

  const query = useQuery({
    queryKey: sadranKeys.mySadranDepartments(profileId),
    queryFn: async (): Promise<DefaultSadranWeek | null> => {
      for (const departmentId of departmentIds) {
        const weeks = await fetchWeeks(departmentId);
        const candidates = weeks
          .filter((w) => w.phase in PHASE_PRIORITY)
          .sort((a, b) => (PHASE_PRIORITY[a.phase] ?? 99) - (PHASE_PRIORITY[b.phase] ?? 99));
        for (const week of candidates) {
          const allowed = await fetchCanManageWeek(departmentId, week.week_start);
          if (allowed) {
            return { departmentId, weekStart: week.week_start };
          }
        }
      }
      return null;
    },
    enabled: !!profileId && departmentsQuery.isSuccess,
    staleTime: 30_000,
  });

  return { data: query.data, isLoading: departmentsQuery.isLoading || query.isLoading };
}
