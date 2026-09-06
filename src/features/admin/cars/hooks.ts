import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

export function useCarsAdmin() {
  return useQuery({ queryKey: carAdminKeys.list(), queryFn: fetchCarsAll, staleTime: 60_000 });
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
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: carAdminKeys.list() }),
  });
}

export function useUpdateCarMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CarUpdate }) => updateCar(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: carAdminKeys.list() }),
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
  return useQuery({ queryKey: carAdminKeys.maintenance(), queryFn: fetchMaintenanceBlocks, staleTime: 30_000 });
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
  return useQuery({ queryKey: carAdminKeys.issues(), queryFn: fetchCarIssues, staleTime: 30_000 });
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
