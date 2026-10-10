import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";

import { useUpdateCarMutation } from "@/features/admin/cars/hooks";
import type { Car } from "@/features/admin/cars/api";

import { fetchCarById, fetchUpcomingCarRides, fetchCarCareHistory, fetchCarIssueHistory, fetchMyResponsibleCars } from "./api";
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
    mutationFn: ({ car, ownerId }: { car: Car; ownerId: string | null }) =>
      update.mutateAsync({
        id: car.id,
        patch: {
          type: ownerId ? "temporary" : "shared",
          owner_id: ownerId,
          access_code: car.access_code,
          is_replaced: car.is_replaced,
          replacement_code: car.replacement_code,
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: carKeys.all }),
  });
}
