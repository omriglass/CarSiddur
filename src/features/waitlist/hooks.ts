import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";


import { cancelWaitlistGroup, fetchWaitlistGroupHolds, fetchWaitlistGroups, joinWaitlistDiscussion, resolveWaitlistGroup } from "./api";
import { waitlistKeys } from "./keys";
import { invalidateWeekData } from "@/features/rides/invalidateWeek";

/** Open contested waiting-list groups for a department/week (RLS: any approved member on a public week). */
export function useWaitlistGroupsQuery(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: waitlistKeys.groups(departmentId ?? "", weekStart ?? ""),
    queryFn: () => fetchWaitlistGroups(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
  });
}

/** REQ §13.157: cars held by the week's open groups (the siddur's free hints, the join form's hours). */
export function useWaitlistGroupHoldsQuery(departmentId: string | undefined, weekStart: string | undefined, enabled = true) {
  return useQuery({
    queryKey: waitlistKeys.holds(departmentId ?? "", weekStart ?? ""),
    queryFn: () => fetchWaitlistGroupHolds(departmentId as string, weekStart as string),
    enabled: enabled && !!departmentId && !!weekStart,
  });
}

/**
 * A resolved/cancelled group turns into a new ride and changes several requests' statuses,
 * all within this one (departmentId, weekStart) — scoped to the board/siddur caches for that
 * week plus the caller's own "my requests" list (they may be a group participant themselves).
 */
function invalidateAfterResolution(
  queryClient: QueryClient,
  departmentId: string,
  weekStart: string,
) {
  void queryClient.invalidateQueries({ queryKey: waitlistKeys.groups(departmentId, weekStart) });
  void queryClient.invalidateQueries({ queryKey: waitlistKeys.holds(departmentId, weekStart) });
  void invalidateWeekData(queryClient, departmentId, weekStart);
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

/** REQ §13.157: join the open discussion this waitlisted request overlaps. */
export function useJoinWaitlistDiscussionMutation(departmentId: string, weekStart: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => joinWaitlistDiscussion(requestId),
    onSuccess: () => invalidateAfterResolution(queryClient, departmentId, weekStart),
  });
}
