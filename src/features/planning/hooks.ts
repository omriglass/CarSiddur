import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { requestsKeys } from "@/features/requests/queryKeys";
import { showErrorToast } from "@/lib/rpc";

import {
  cancelReservation,
  fetchOwnReservation,
  fetchPlanningMonth,
  fetchPlanningSettings,
  fetchTypicalUsage,
  saveReservation,
} from "./api";
import { planningKeys } from "./keys";

export function usePlanningMonthQuery(departmentId: string | undefined, from: string, to: string) {
  return useQuery({
    queryKey: planningKeys.month(departmentId ?? "", from, to),
    queryFn: () => fetchPlanningMonth(departmentId as string, from, to),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
}

export function useTypicalUsageQuery(departmentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: planningKeys.typicalUsage(departmentId ?? ""),
    queryFn: () => fetchTypicalUsage(departmentId as string),
    enabled: !!departmentId && enabled,
    staleTime: 60 * 60_000,
  });
}

export function usePlanningSettingsQuery(departmentId: string | undefined) {
  return useQuery({
    queryKey: planningKeys.settings(departmentId ?? ""),
    queryFn: () => fetchPlanningSettings(departmentId as string),
    enabled: !!departmentId,
    staleTime: 10 * 60_000,
  });
}

export function useOwnReservationQuery(reservationId: string | undefined) {
  return useQuery({
    queryKey: planningKeys.ownReservation(reservationId ?? ""),
    queryFn: () => fetchOwnReservation(reservationId as string),
    enabled: !!reservationId,
  });
}

/** Saving or cancelling a reservation refreshes the month view and the /my suggestions. */
function useInvalidatePlanning() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: planningKeys.all });
    void queryClient.invalidateQueries({ queryKey: requestsKeys.all });
  };
}

export function useSaveReservationMutation() {
  const invalidate = useInvalidatePlanning();
  return useMutation({ mutationFn: saveReservation, onSuccess: invalidate, onError: showErrorToast });
}

export function useCancelReservationMutation() {
  const invalidate = useInvalidatePlanning();
  return useMutation({ mutationFn: cancelReservation, onSuccess: invalidate, onError: showErrorToast });
}
