import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showErrorToast } from "@/lib/rpc";

import {
  fetchCars,
  fetchCarSeatConfigs,
  fetchDestinations,
  fetchMyTemporaryCars,
  fetchRideTypes,
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

export function useDestinations() {
  return useQuery({
    queryKey: fleetKeys.destinations(),
    queryFn: fetchDestinations,
    staleTime: 10 * 60_000,
  });
}

export function useRideTypes() {
  return useQuery({
    queryKey: fleetKeys.rideTypes(),
    queryFn: fetchRideTypes,
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

export function useMyTemporaryCars(ownerId: string | undefined) {
  return useQuery({
    queryKey: fleetKeys.myTemporaryCars(ownerId),
    queryFn: () => fetchMyTemporaryCars(ownerId as string),
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

export function useSuggestDestinationMutation() {
  return useMutation({
    mutationFn: ({ name, zone }: { name: string; zone?: string }) => suggestDestination(name, zone),
    onError: showErrorToast,
  });
}
