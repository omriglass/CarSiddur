import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";

import { useUpdateCarMutation } from "@/features/admin/cars/hooks";
import type { Car, CarUpdate } from "@/features/admin/cars/api";

import {
  fetchCarById,
  fetchCarCorporations,
  fetchOpenCarIssues,
  updateCarIssue,
  fetchCarCareHistory,
  fetchCarCurrentKm,
  fetchCarIssueHistory,
  fetchCarsByIds,
  fetchCarOdometerHistory,
  fetchMyResponsibleCars,
  fetchUpcomingCarRides,
  addCarOwner,
  removeCarOwner,
  setCarStatusOnly,
  setOwnPrivateCar,
} from "./api";
import { carKeys } from "./keys";

export function useCarQuery(carId: string | undefined) {
  return useQuery({
    queryKey: carKeys.detail(carId),
    queryFn: () => fetchCarById(carId as string),
    enabled: !!carId,
  });
}

export function useCarIssueHistoryQuery(carId: string | undefined) {
  return useQuery({
    queryKey: carKeys.issues(carId),
    queryFn: () => fetchCarIssueHistory(carId as string),
    enabled: !!carId,
  });
}

export function useCarCareHistoryQuery(carId: string | undefined) {
  return useQuery({
    queryKey: carKeys.careEvents(carId),
    queryFn: () => fetchCarCareHistory(carId as string),
    enabled: !!carId,
  });
}

export function useCarOdometerHistoryQuery(carId: string | undefined) {
  return useQuery({
    queryKey: carKeys.odometer(carId),
    queryFn: () => fetchCarOdometerHistory(carId as string),
    enabled: !!carId,
  });
}

/** The car's current kilometrage (null = no reading yet); refetched on open so the form shows the latest. */
export function useCarCurrentKmQuery(carId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: carKeys.currentKm(carId),
    queryFn: () => fetchCarCurrentKm(carId as string),
    enabled: !!carId && enabled,
    staleTime: 0,
  });
}

/** "הרכבים באחריותי" Home card (`HomePage.tsx`). */
export function useMyResponsibleCarsQuery() {
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({
    queryKey: carKeys.myResponsible(profileId),
    queryFn: () => fetchMyResponsibleCars(profileId as string),
    enabled: !!profileId,
    staleTime: 60_000,
  });
}

/** MC1 (REQ item 218): the cars of the rides I am on now ("רכבים רלוונטיים" on /my). */
export function useCarsByIdsQuery(carIds: readonly string[]) {
  return useQuery({
    queryKey: carKeys.byIds(carIds),
    queryFn: () => fetchCarsByIds(carIds),
    enabled: carIds.length > 0,
    staleTime: 60_000,
  });
}

/** Read fresh when the "make private" dialog opens. */
export function useUpcomingCarRidesQuery(carId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: carKeys.upcomingRides(carId),
    queryFn: () => fetchUpcomingCarRides(carId as string),
    enabled: !!carId && enabled,
    staleTime: 0,
  });
}

/**
 * Shared <-> private (type + owner_id move together, `cars_temporary_owner_ck`). `updateCar` rewrites the
 * access-code row from the patch, so the car's current codes are passed through to keep them.
 */
export function useSetCarPrivateMutation() {
  const queryClient = useQueryClient();
  const update = useUpdateCarMutation();
  return useMutation({
    /** `asOwner`: the viewer holds the private car and is not otherwise its editor (R19B13). */
    mutationFn: async ({ car, ownerId, asOwner = false }: { car: Car; ownerId: string | null; asOwner?: boolean }): Promise<void> => {
      if (asOwner) return setOwnPrivateCar(car.id, ownerId);
      await update.mutateAsync({
        id: car.id,
        patch: {
          type: ownerId ? "temporary" : "shared",
          owner_id: ownerId,
          access_code: car.access_code,
          is_replaced: car.is_replaced,
          replacement_code: car.replacement_code,
        },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: carKeys.all }),
  });
}

/** Status-only change (a car administrator on a private car). */
export function useSetCarStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ carId, status }: { carId: string; status: Car["status"] }) => setCarStatusOnly(carId, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: carKeys.all }),
  });
}

/** PC1 (REQ item 227): add / remove an owner of a private car; every car read refreshes (owners are embedded). */
export function useCarOwnerMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ carId, profileId, remove = false }: { carId: string; profileId: string; remove?: boolean }) =>
      remove ? removeCarOwner(carId, profileId) : addCarOwner(carId, profileId),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: carKeys.all }),
      // the siddur / board car lists and Profile's "my private cars" carry the owners too
      queryClient.invalidateQueries({ queryKey: ["fleet"] }),
    ]),
  });
}

/** CR1 (REQ item 257): the open issues of `carIds` (empty = no query). */
export function useOpenCarIssuesQuery(carIds: readonly string[]) {
  return useQuery({
    queryKey: carKeys.openIssues(carIds),
    queryFn: () => fetchOpenCarIssues(carIds),
    enabled: carIds.length > 0,
    staleTime: 60_000,
  });
}

/** CR1: the corporation names already used on any car (suggestions for "תאגיד"). */
export function useCarCorporationsQuery(enabled: boolean) {
  return useQuery({ queryKey: carKeys.corporations(), queryFn: fetchCarCorporations, enabled, staleTime: 5 * 60_000 });
}

/**
 * CR1: one in-place edit on the car page — `patch` holds only the fields that changed (the access-code row is
 * written only when the patch carries a code key, `updateCar`). Refreshes the car page and every car read.
 */
export function useSaveCarFieldsMutation() {
  const queryClient = useQueryClient();
  const update = useUpdateCarMutation();
  return useMutation({
    mutationFn: ({ carId, patch }: { carId: string; patch: CarUpdate }) => update.mutateAsync({ id: carId, patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: carKeys.all }),
  });
}

/** CR2: resolve / reword an issue; refreshes the car page history, every open-issue list and the admin issues list. */
export function useUpdateCarIssueMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ issueId, action, description }: { issueId: string; action: "resolve" | "edit"; description?: string }) =>
      updateCarIssue(issueId, action, description),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: carKeys.all }),
      queryClient.invalidateQueries({ queryKey: ["admin", "cars", "issues"] }),
      queryClient.invalidateQueries({ queryKey: ["carCare"] }),
    ]),
  });
}
