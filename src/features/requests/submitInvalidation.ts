import type { QueryClient } from "@tanstack/react-query";

import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";

import { requestsKeys } from "./queryKeys";

/**
 * What a submit refreshes: my requests, my upcoming rides, the submitted request and its week's board data.
 * `refetchType: 'none'` only marks them stale (the next screen's mount refetches them): the request form is
 * still mounted when this runs and must not reload its own catalogs, template suggestions and route previews.
 */
export function invalidateSubmittedRequest(
  queryClient: QueryClient,
  profileId: string | undefined,
  target: { departmentId: string; weekStart: string; requestId?: string | null },
  options: { refetchType?: "active" | "none"; peopleChanged?: boolean; templateChanged?: boolean; broad?: boolean } = {},
): void {
  const refetchType = options.refetchType ?? "active";
  const mark = (queryKey: readonly unknown[]) => void queryClient.invalidateQueries({ queryKey, refetchType });
  mark(requestsKeys.mine(profileId));
  mark(siddurKeys.myUpcomingRides(undefined, undefined).slice(0, 2));
  if (target.requestId) mark(requestsKeys.byId(target.requestId));
  mark(sadranKeys.week(target.departmentId, target.weekStart));
  mark(siddurKeys.boardRides(target.departmentId, target.weekStart));
  mark(siddurKeys.carLocations(target.departmentId, target.weekStart));
  if (options.peopleChanged && target.requestId) {
    // Companions / named children changed after the submit: the people lists and the ride sheets of that week.
    mark(requestsKeys.companions(target.requestId));
    mark(requestsKeys.recentCompanions(profileId));
  }
  if (options.templateChanged) mark(requestsKeys.templateSuggestions(profileId));
  if (options.broad) {
    // A multi-day series (or a failed follow-up call) can touch any week: mark everything stale.
    for (const key of [requestsKeys.all, siddurKeys.all, sadranKeys.all]) mark(key);
  }
}
