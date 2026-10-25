import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createDestination,
  calculateDestinationRoute,
  fetchAllDestinations,
  fetchFreeTextQueue,
  fetchIgnoredPlaceTexts,
  ignorePlaceText,
  mergeFreeTextIntoDestination,
  unignorePlaceText,
  updateDestination,
  type DestinationInsert,
  type DestinationUpdate,
} from "./api";
import { destinationAdminKeys } from "./queryKeys";

export function useDestinationsAdmin() {
  const { departmentId } = useActiveDepartment();
  return useQuery({ queryKey: [...destinationAdminKeys.list(), departmentId], enabled: !!departmentId, queryFn: () => fetchAllDestinations(departmentId as string), staleTime: 60_000 });
}

export function useFreeTextQueue() {
  const { departmentId } = useActiveDepartment();
  return useQuery({ queryKey: [...destinationAdminKeys.freeTextQueue(), departmentId], enabled: !!departmentId, queryFn: () => fetchFreeTextQueue(departmentId as string), staleTime: 60_000 });
}

export function useIgnoredPlaceTexts() {
  const { departmentId } = useActiveDepartment();
  return useQuery({ queryKey: [...destinationAdminKeys.ignored(), departmentId], enabled: !!departmentId, queryFn: () => fetchIgnoredPlaceTexts(departmentId as string), staleTime: 60_000 });
}

export function useIgnorePlaceTextMutation() {
  const { departmentId } = useActiveDepartment();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => ignorePlaceText(departmentId as string, text),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: destinationAdminKeys.ignored() }),
  });
}

export function useUnignorePlaceTextMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unignorePlaceText(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: destinationAdminKeys.ignored() }),
  });
}

export function useCreateDestinationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DestinationInsert) => createDestination(input),
    // `all`: a new place (or a renamed / re-approved one) can take texts out of the free-text queue.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: destinationAdminKeys.all }),
  });
}

export function useUpdateDestinationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DestinationUpdate }) => updateDestination(id, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: destinationAdminKeys.all }),
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

export function useCalculateDestinationRouteMutation() {
  return useMutation({ mutationFn: ({ departmentId, destinationId }: { departmentId: string; destinationId: string }) =>
    calculateDestinationRoute(departmentId, destinationId) });
}
