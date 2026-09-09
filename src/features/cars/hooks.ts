import { useQuery } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";

import { fetchCarById, fetchCarCareHistory, fetchCarIssueHistory, fetchMyResponsibleCars } from "./api";
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
