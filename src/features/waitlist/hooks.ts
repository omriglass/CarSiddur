import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { requestsKeys } from "@/features/requests/queryKeys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";

import { cancelWaitlistGroup, fetchWaitlistGroups, resolveWaitlistGroup } from "./api";
import { waitlistKeys } from "./keys";

/** Open contested waiting-list groups for a department/week (RLS: any approved member on a public week). */
export function useWaitlistGroupsQuery(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: waitlistKeys.groups(departmentId ?? "", weekStart ?? ""),
    queryFn: () => fetchWaitlistGroups(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
  });
}

/** A resolved/cancelled group turns into a new ride and changes several requests' statuses — invalidate everywhere those are read. */
function invalidateAfterResolution(queryClient: QueryClient, departmentId: string, weekStart: string) {
  void queryClient.invalidateQueries({ queryKey: waitlistKeys.groups(departmentId, weekStart) });
  void queryClient.invalidateQueries({ queryKey: siddurKeys.all });
  void queryClient.invalidateQueries({ queryKey: sadranKeys.week(departmentId, weekStart) });
  void queryClient.invalidateQueries({ queryKey: requestsKeys.all });
}

export function useResolveWaitlistGroupMutation(departmentId: string, weekStart: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { groupId: string; requestIds: string[]; expectedVersion: number }) =>
      resolveWaitlistGroup(vars.groupId, vars.requestIds, vars.expectedVersion),
    onSuccess: () => invalidateAfterResolution(queryClient, departmentId, weekStart),
  });
}

export function useCancelWaitlistGroupMutation(departmentId: string, weekStart: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { groupId: string; expectedVersion: number }) => cancelWaitlistGroup(vars.groupId, vars.expectedVersion),
    onSuccess: () => invalidateAfterResolution(queryClient, departmentId, weekStart),
  });
}
