import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createDestination,
  calculateDestinationRoute,
  fetchAllDestinations,
  fetchFreeTextQueue,
  fetchIgnoredPlaceTexts,
  locateDestinations,
  LOCATE_BATCH,
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

/**
 * REQ §13.175 (e): one button — every place still missing its coordinates is looked up on Google (in batches) and saved
 * like a hand edit. Returns how many were saved and the names Google could not find.
 */
export function useLocateMissingDestinationsMutation() {
  const { departmentId } = useActiveDepartment();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (places: readonly { id: string; name: string }[]) => {
      let updated = 0;
      const notFound: string[] = [];
      for (let i = 0; i < places.length; i += LOCATE_BATCH) {
        const batch = places.slice(i, i + LOCATE_BATCH);
        const results = await locateDestinations(departmentId as string, batch.map((place) => place.id));
        for (const place of batch) {
          const found = results.find((result) => result.id === place.id);
          if (found && "lat" in found) {
            await updateDestination(place.id, { lat: found.lat, lng: found.lng });
            updated += 1;
          } else {
            notFound.push(place.name);
          }
        }
      }
      return { updated, notFound };
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: destinationAdminKeys.all }),
  });
}
