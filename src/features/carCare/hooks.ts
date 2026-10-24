import { useMutation, useQueryClient } from "@tanstack/react-query";

import { carKeys } from "@/features/cars/keys";
import { carTaskKeys } from "@/features/carTasks/keys";
import { showErrorToast } from "@/lib/rpc";

import { logCarCare, logCarKilometrage, reportCarIssue, setCarKilometrage } from "./api";
import { carCareKeys } from "./keys";

/**
 * Also invalidates `features/cars`' own history query keys (`carKeys.issues`/
 * `careEvents`) alongside this feature's own `carCareKeys` — the
 * responsible-person/admin History tab on `/cars/:carId` reads those, and a
 * fresh report/tire-fill/wash should show there immediately without a
 * manual refresh. Invalidating from the mutation side (here) rather than
 * from `features/cars`' read hooks keeps `carCare`'s `api.ts` the only
 * place that writes these rows, and `features/cars` free of any dependency
 * on when/how they were written.
 */
export function useReportCarIssueMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: reportCarIssue,
    onSuccess: (_result, { carId }) => {
      void queryClient.invalidateQueries({ queryKey: carCareKeys.issues(carId) });
      void queryClient.invalidateQueries({ queryKey: carKeys.issues(carId) });
    },
    onError: showErrorToast,
  });
}

export function useLogCarCareMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logCarCare,
    onSuccess: (_result, { carId }) => {
      void queryClient.invalidateQueries({ queryKey: carCareKeys.events(carId) });
      void queryClient.invalidateQueries({ queryKey: carKeys.careEvents(carId) });
      void queryClient.invalidateQueries({ queryKey: carTaskKeys.all }); // a log completes the car's matching open task
    },
    onError: showErrorToast,
  });
}

/** A kilometrage reading (member) — refreshes the car's current km and its history list. */
export function useLogCarKilometrageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logCarKilometrage,
    onSuccess: (_result, { carId }) => {
      void queryClient.invalidateQueries({ queryKey: carKeys.currentKm(carId) });
      void queryClient.invalidateQueries({ queryKey: carKeys.odometer(carId) });
      void queryClient.invalidateQueries({ queryKey: carTaskKeys.all });
    },
    onError: showErrorToast,
  });
}

/** A manager's kilometrage correction (`can_manage_car`). */
export function useSetCarKilometrageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setCarKilometrage,
    onSuccess: (_result, { carId }) => {
      void queryClient.invalidateQueries({ queryKey: carKeys.currentKm(carId) });
      void queryClient.invalidateQueries({ queryKey: carKeys.odometer(carId) });
    },
    onError: showErrorToast,
  });
}
