import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchSadranAssignments, setStandingDefault, setWeekAssignments } from "./api";
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
    },
  });
}
