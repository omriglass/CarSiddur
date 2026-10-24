import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showErrorToast } from "@/lib/rpc";

import { completeCarTask, fetchCarTasks, fetchMyCarTasks, requestCarTasks, withdrawCarTask } from "./api";
import { carTaskKeys } from "./keys";

/** Re-read once a minute: the window opens at exactly 15 minutes before the ride, no push is needed for the card. */
const MY_TASKS_REFETCH_MS = 60_000;

export function useMyCarTasksQuery() {
  return useQuery({
    queryKey: carTaskKeys.mine(),
    queryFn: fetchMyCarTasks,
    refetchInterval: MY_TASKS_REFETCH_MS,
    refetchOnWindowFocus: true,
  });
}

export function useCarTasksQuery(carId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: carTaskKeys.car(carId),
    queryFn: () => fetchCarTasks(carId as string),
    enabled: !!carId && enabled,
  });
}

export function useRequestCarTasksMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: requestCarTasks,
    onSuccess: (_n, { carId }) => {
      void queryClient.invalidateQueries({ queryKey: carTaskKeys.car(carId) });
      void queryClient.invalidateQueries({ queryKey: carTaskKeys.mine() });
    },
    onError: showErrorToast,
  });
}

export function useWithdrawCarTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: withdrawCarTask,
    onSuccess: (_r, { carId }) => {
      void queryClient.invalidateQueries({ queryKey: carTaskKeys.car(carId) });
      void queryClient.invalidateQueries({ queryKey: carTaskKeys.mine() });
    },
    onError: showErrorToast,
  });
}

export function useCompleteCarTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: completeCarTask,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: carTaskKeys.all });
    },
    onError: showErrorToast,
  });
}
