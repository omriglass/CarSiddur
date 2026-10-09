import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { carAdminKeys } from "@/features/admin/cars/queryKeys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { showErrorToast } from "@/lib/rpc";

import {
  createCarMaintenance,
  deleteCarMaintenance,
  markIssueUnsafeMaintenance,
  updateCarMaintenance,
  fetchCars,
  fetchCarSeatConfigs,
  fetchDestinations,
  fetchMaintenanceBlocks,
  fetchMyTemporaryCars,
  fetchRideTypes,
  fetchTurnaroundMinutes,
  registerTemporaryCar,
  suggestDestination,
} from "./api";
import { canEditMaintenance } from "./maintenance";
import { fleetKeys } from "./queryKeys";

export function useCars(departmentId: string | undefined) {
  return useQuery({
    queryKey: fleetKeys.cars(departmentId),
    queryFn: () => fetchCars(departmentId as string),
    enabled: !!departmentId,
    staleTime: 5 * 60_000,
  });
}

export function useDestinations(departmentOverride?: string) {
  const active = useActiveDepartment();
  const departmentId = departmentOverride ?? active.departmentId;
  return useQuery({
    queryKey: [...fleetKeys.destinations(), departmentId],
    queryFn: () => fetchDestinations(departmentId as string),
    enabled: !!departmentId,
    staleTime: 10 * 60_000,
  });
}

export function useRideTypes(departmentOverride?: string) {
  const active = useActiveDepartment();
  const departmentId = departmentOverride ?? active.departmentId;
  return useQuery({
    queryKey: [...fleetKeys.rideTypes(), departmentId],
    queryFn: () => fetchRideTypes(departmentId as string),
    enabled: !!departmentId,
    staleTime: 10 * 60_000,
  });
}

export function useCarSeatConfigs(departmentId: string | undefined) {
  return useQuery({
    queryKey: fleetKeys.seatConfigs(departmentId),
    queryFn: () => fetchCarSeatConfigs(departmentId as string),
    enabled: !!departmentId,
    staleTime: 5 * 60_000,
  });
}

/** For the quick-request sheet's client-side free-window pre-check (`features/siddur/freeWindows.ts`). */
export function useTurnaroundMinutes(departmentId: string | undefined) {
  return useQuery({
    queryKey: fleetKeys.turnaroundMinutes(departmentId),
    queryFn: () => fetchTurnaroundMinutes(departmentId as string),
    enabled: !!departmentId,
    staleTime: 5 * 60_000,
  });
}

export function useMaintenanceBlocks(departmentId: string | undefined) {
  return useQuery({
    queryKey: fleetKeys.maintenanceBlocks(departmentId),
    queryFn: () => fetchMaintenanceBlocks(departmentId as string),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
}

export function useMyTemporaryCars(ownerId: string | undefined) {
  const { departmentId } = useActiveDepartment();
  return useQuery({
    queryKey: [...fleetKeys.myTemporaryCars(ownerId), departmentId],
    queryFn: async () => (await fetchMyTemporaryCars(ownerId as string)).filter((car) => car.department_id === departmentId),
    enabled: !!ownerId,
    staleTime: 60_000,
  });
}

export function useRegisterTemporaryCarMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: registerTemporaryCar,
    onSuccess: (car) => {
      queryClient.invalidateQueries({ queryKey: fleetKeys.myTemporaryCars(car.owner_id ?? undefined) });
      queryClient.invalidateQueries({ queryKey: fleetKeys.cars(car.department_id) });
    },
    onError: showErrorToast,
  });
}

export function useSuggestDestinationMutation(departmentOverride?: string) {
  const active = useActiveDepartment();
  const departmentId = departmentOverride ?? active.departmentId;
  return useMutation({
    mutationFn: ({ name, zone }: { name: string; zone?: string }) => { if (!departmentId) throw new Error("Missing department"); return suggestDestination(departmentId, name, zone); },
    onError: showErrorToast,
  });
}

/**
 * A maintenance period changed (REQ §13.114): the bands on the siddur / board, the car page, the admin screens
 * and the rides the server flagged or un-flagged all refresh. Not week-scoped — a period can span weeks.
 */
function invalidateMaintenance(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["fleet", "maintenanceBlocks"] });
  void queryClient.invalidateQueries({ queryKey: sadranKeys.all });
  void queryClient.invalidateQueries({ queryKey: siddurKeys.all });
  void queryClient.invalidateQueries({ queryKey: carAdminKeys.all });
}

export function useCreateCarMaintenanceMutation() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: createCarMaintenance, onSuccess: () => invalidateMaintenance(queryClient), onError: showErrorToast });
}

export function useUpdateCarMaintenanceMutation() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: updateCarMaintenance, onSuccess: () => invalidateMaintenance(queryClient), onError: showErrorToast });
}

export function useDeleteCarMaintenanceMutation() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: deleteCarMaintenance, onSuccess: () => invalidateMaintenance(queryClient), onError: showErrorToast });
}

export function useMarkIssueUnsafeMaintenanceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: markIssueUnsafeMaintenance,
    onSuccess: () => invalidateMaintenance(queryClient),
    onError: showErrorToast,
  });
}

/**
 * `(car) => boolean`: may I create / move / resize / remove maintenance periods of this car? Mirror of the
 * server rule; the RPCs re-check. `forceStaff` is for screens only Sadranim/admins reach (the board).
 */
export function useCanEditMaintenance(departmentId: string | undefined, forceStaff = false) {
  const profile = useProfile().data;
  const memberships = useMyDepartments().data;
  const isDepartmentSadran = forceStaff || (memberships ?? []).some((m) => m.department_id === departmentId && m.role === "sadran");
  const isAdmin = !!profile?.is_admin;
  const profileId = profile?.id;
  return useCallback(
    (car: { responsible_id?: string | null } | undefined) =>
      canEditMaintenance({ isAdmin, isDepartmentSadran, profileId, carResponsibleId: car?.responsible_id }),
    [isAdmin, isDepartmentSadran, profileId],
  );
}
