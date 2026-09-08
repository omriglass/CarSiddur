import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchDutyRoster, fetchSadranAssignments, setStandingDefault, setWeekAssignments } from "./api";
import { memberAdminKeys } from "../members/queryKeys";
import { rosterAdminKeys } from "./queryKeys";

export function useSadranAssignments(weekStarts: string[]) {
  return useQuery({
    queryKey: rosterAdminKeys.assignments(weekStarts),
    queryFn: () => fetchSadranAssignments(weekStarts),
    enabled: weekStarts.length > 0,
    staleTime: 30_000,
  });
}

export function useSetWeekAssignmentsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ departmentId, weekStart, profileIds }: { departmentId: string; weekStart: string; profileIds: string[] }) =>
      setWeekAssignments(departmentId, weekStart, profileIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rosterAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: memberAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["auth"] });
      void queryClient.invalidateQueries({ queryKey: ["sadran"] });
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });
}

export function useSetStandingDefaultMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ departmentId, profileIds }: { departmentId: string; profileIds: string[] }) =>
      setStandingDefault(departmentId, profileIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rosterAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: memberAdminKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["auth"] });
      void queryClient.invalidateQueries({ queryKey: ["sadran"] });
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
    },
  });
}

export function useDutyRoster(departmentIds: string[], weekStarts: string[]) {
  return useQuery({
    queryKey: [...rosterAdminKeys.all, "duty", departmentIds, weekStarts],
    queryFn: () => fetchDutyRoster(departmentIds, weekStarts),
    enabled: departmentIds.length > 0 && weekStarts.length > 0,
    staleTime: 30_000,
  });
}
