import { useQuery } from "@tanstack/react-query";

import { fetchSadranimOf } from "@/features/auth/api";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useSession } from "@/features/auth/useSession";
import { fetchWeeks } from "@/features/siddur/api";

import { sadranKeys } from "./keys";

export interface DefaultSadranWeek {
  departmentId: string;
  weekStart: string;
}

/** `open` before `live` (a Sadran lands here to work the request window first, REQ §4); anything else is never a default. */
const PHASE_PRIORITY: Record<string, number> = { open: 0, live: 1 };

/**
 * Resolves which `(departmentId, weekStart)` the bare `/sadran` route should
 * redirect to: the first department I'm Sadran of, preferring its currently
 * `open` week over a `live` one. Mirrors `useIsSadranAnywhere`'s resolution
 * (`sadranim_of` RPC) rather than reimplementing it.
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
          .filter((w) => w.phase === "open" || w.phase === "live")
          .sort((a, b) => (PHASE_PRIORITY[a.phase] ?? 99) - (PHASE_PRIORITY[b.phase] ?? 99));
        for (const week of candidates) {
          const sadranim = await fetchSadranimOf(departmentId, week.week_start);
          if (profileId && sadranim.includes(profileId)) {
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
