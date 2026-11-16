// REQ item 246 (LT1): hop minutes of an unsaved route for the stop-hours timing rule (`route_hops_preview`).
// Its own module (not hooks.ts) so the many form tests that mock hooks.ts keep working unchanged; an
// unreachable preview simply leaves the schedule out (the form then shows no stop hours).
import { useQuery } from "@tanstack/react-query";

import { fetchRouteHopsPreview, type RoutePreviewPoint } from "./api";
import { requestsKeys } from "./queryKeys";

export function useRouteHopsQuery(departmentId: string | undefined, points: readonly RoutePreviewPoint[], enabled: boolean) {
  return useQuery({
    queryKey: requestsKeys.routeHops(departmentId, points),
    queryFn: () => fetchRouteHopsPreview(departmentId as string, points),
    enabled: enabled && !!departmentId && points.length > 1,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: false,
  });
}
