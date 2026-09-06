import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createDestination,
  fetchAllDestinations,
  fetchFreeTextQueue,
  mergeFreeTextIntoDestination,
  updateDestination,
  type DestinationInsert,
  type DestinationUpdate,
} from "./api";
import { destinationAdminKeys } from "./queryKeys";

export function useDestinationsAdmin() {
  return useQuery({ queryKey: destinationAdminKeys.list(), queryFn: fetchAllDestinations, staleTime: 60_000 });
}

export function useFreeTextQueue() {
  return useQuery({ queryKey: destinationAdminKeys.freeTextQueue(), queryFn: fetchFreeTextQueue, staleTime: 60_000 });
}

export function useCreateDestinationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DestinationInsert) => createDestination(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: destinationAdminKeys.list() }),
  });
}

export function useUpdateDestinationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DestinationUpdate }) => updateDestination(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: destinationAdminKeys.list() }),
  });
}

export function useMergeFreeTextMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ destinationId, freeText }: { destinationId: string; freeText: string }) =>
      mergeFreeTextIntoDestination(destinationId, freeText),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: destinationAdminKeys.all }),
  });
}
