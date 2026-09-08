import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showErrorToast } from "@/lib/rpc";

import {
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
