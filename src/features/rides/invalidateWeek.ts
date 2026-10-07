import type { Query, QueryClient } from "@tanstack/react-query";

import { requestsKeys } from "@/features/requests/queryKeys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";

/** `siddur` query families keyed by `(departmentId, weekStart)` at positions 2 and 3. */
const WEEK_KEYED_SIDDUR = new Set<unknown>(["boardRides", "carLocations", "weekExport"]);

/**
 * Every `siddur` query except week-keyed data of *other* weeks (code review 2026-09-24 R7).
 * Non-week siddur queries (weeks/phases, a ride's detail, my upcoming rides, car lookups) may
 * all reflect a ride change, so they refresh as before; only other weeks' rides are skipped.
 */
export function isSiddurQueryAffectedByWeek(query: Pick<Query, "queryKey">, departmentId: string, weekStart: string): boolean {
  const [root, family, dept, week] = query.queryKey;
  if (root !== siddurKeys.all[0]) return false;
  if (!WEEK_KEYED_SIDDUR.has(family)) return true;
  return dept === departmentId && week === weekStart;
}

/**
 * Refresh everything a ride/request change in one department-week can affect: that week's
 * Sadran board, the siddur (minus other weeks' rides), and the requests feature. The requests
 * keys are all per-user or per-request, so `requestsKeys.all` costs nothing extra and keeps
 * `byId`/`companions`/`freedOffers` fresh. Callers add feature-specific keys (waitlist, inbox).
 */
export function invalidateWeekData(queryClient: QueryClient, departmentId: string, weekStart: string): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: sadranKeys.week(departmentId, weekStart) }),
    // REQ item 108 (M1): the server's merge verdicts/windows are not week-keyed; any ride or request change can alter them.
    queryClient.invalidateQueries({ queryKey: sadranKeys.mergePreviews() }),
    queryClient.invalidateQueries({ predicate: (query) => isSiddurQueryAffectedByWeek(query, departmentId, weekStart) }),
    queryClient.invalidateQueries({ queryKey: requestsKeys.all }),
  ]);
}
