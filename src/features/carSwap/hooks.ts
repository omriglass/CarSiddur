import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";


import { previewDayCarSwap, swapDayCars } from "./api";
import { carSwapKeys } from "./keys";

import type { CarSwapArgs, SwapDayCarsArgs } from "./api";
import { invalidateWeekData } from "@/features/rides/invalidateWeek";

/**
 * `null` params disable the query (dialog closed / cars not yet chosen) —
 * TanStack Query only, no `useEffect` fetching (CLAUDE.md "Data").
 * `staleTime: 0` so reopening the dialog for the same two cars always
 * re-checks (the day may have changed under the Sadran/member since).
 */
export function useCarSwapPreviewQuery(params: CarSwapArgs | null) {
  return useQuery({
    queryKey: params
      ? carSwapKeys.preview(params.departmentId, params.weekStart, params.day, params.carA, params.carB)
      : carSwapKeys.all,
    queryFn: () => previewDayCarSwap(params as CarSwapArgs),
    enabled: !!params,
    staleTime: 0,
  });
}

/** Invalidates board rides + car locations + siddur queries on success (CLAUDE.md "Data") — both screens read the same underlying rides/car-location data, scoped to the one (departmentId, weekStart) the swap ran on. */
export function useCarSwapMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: SwapDayCarsArgs) => swapDayCars(args),
    onSuccess: (_data, { departmentId, weekStart }) => {
      void invalidateWeekData(queryClient, departmentId, weekStart);
    },
  });
}
