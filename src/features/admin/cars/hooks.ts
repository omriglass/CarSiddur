import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { fleetKeys } from "@/features/fleet/queryKeys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";

import {
  createCar,
  createMaintenanceBlock,
  endMaintenanceBlockNow,
  fetchCarIssues,
  fetchCarsAll,
  fetchMaintenanceBlocks,
  fetchSeatConfigs,
  moveIssueToMaintenance,
  replaceSeatConfigs,
  resolveCarIssue,
  updateCar,
  type CarInsert,
  type CarUpdate,
} from "./api";
import { carAdminKeys } from "./queryKeys";

import type { Passengers } from "@/solver";

/** Car details also live in member and board caches, including embedded ride rows. */
async function invalidateCarQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: carAdminKeys.list() }),
    queryClient.invalidateQueries({ queryKey: ["requests"] }),
    queryClient.invalidateQueries({ queryKey: fleetKeys.cars(undefined).slice(0, 2) }),
    queryClient.invalidateQueries({ queryKey: fleetKeys.myTemporaryCars(undefined).slice(0, 2) }),
    queryClient.invalidateQueries({ queryKey: siddurKeys.carForRide(undefined).slice(0, 2) }),
    queryClient.invalidateQueries({ queryKey: siddurKeys.boardRides("", "").slice(0, 2) }),
    queryClient.invalidateQueries({ queryKey: siddurKeys.boardRideById(undefined).slice(0, 2) }),
    queryClient.invalidateQueries({ queryKey: ["siddur", "myUpcomingRides"] }),
    queryClient.invalidateQueries({
      queryKey: sadranKeys.all,
      predicate: ({ queryKey }) => queryKey.at(-1) === "cars" || queryKey.at(-1) === "boardRides",
    }),
  ]);
}

export function useCarsAdmin() {
  const { departmentId } = useActiveDepartment();
  return useQuery({ queryKey: [...carAdminKeys.list(), departmentId], queryFn: async () => (await fetchCarsAll()).filter((row) => row.department_id === departmentId), staleTime: 60_000 });
}

export function useSeatConfigs(carId: string | undefined) {
  return useQuery({
    queryKey: carAdminKeys.seatConfigs(carId),
    queryFn: () => fetchSeatConfigs(carId as string),
    enabled: !!carId,
  });
}

export function useCreateCarMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CarInsert) => createCar(input),
    onSuccess: () => invalidateCarQueries(queryClient),
  });
}

export function useUpdateCarMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CarUpdate }) => updateCar(id, patch),
    onSuccess: () => invalidateCarQueries(queryClient),
  });
}

export function useReplaceSeatConfigsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ carId, configs }: { carId: string; configs: Passengers[] }) => replaceSeatConfigs(carId, configs),
    onSuccess: (_data, variables) =>
      void queryClient.invalidateQueries({ queryKey: carAdminKeys.seatConfigs(variables.carId) }),
  });
}

export function useMaintenanceBlocks() {
  const { departmentId } = useActiveDepartment();
  return useQuery({ queryKey: [...carAdminKeys.maintenance(), departmentId], queryFn: async () => (await fetchMaintenanceBlocks()).filter((row) => row.department_id === departmentId), staleTime: 30_000 });
}

export function useCreateMaintenanceBlockMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createMaintenanceBlock,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: carAdminKeys.maintenance() }),
  });
}

export function useEndMaintenanceBlockMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (blockId: string) => endMaintenanceBlockNow(blockId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: carAdminKeys.maintenance() }),
  });
}

export function useCarIssues() {
  const { departmentId } = useActiveDepartment();
  return useQuery({ queryKey: [...carAdminKeys.issues(), departmentId], queryFn: async () => (await fetchCarIssues()).filter((row) => row.department_id === departmentId), staleTime: 30_000 });
}

export function useResolveCarIssueMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issueId: string) => resolveCarIssue(issueId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: carAdminKeys.issues() }),
  });
}

export function useMoveIssueToMaintenanceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, hours }: { issueId: string; hours: number }) => moveIssueToMaintenance(issueId, hours),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: carAdminKeys.issues() });
      void queryClient.invalidateQueries({ queryKey: carAdminKeys.maintenance() });
      void queryClient.invalidateQueries({ queryKey: carAdminKeys.list() });
    },
  });
}
