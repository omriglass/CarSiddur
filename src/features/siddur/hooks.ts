import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/features/auth/useSession";

import {
  fetchBoardRideById,
  fetchMyChildren,
  fetchMyChildrenRides,
  fetchMyUpcomingRides,
  fetchBoardRides,
  fetchCarForRide,
  fetchCarLocations,
  fetchCarStartLocationIds,
  fetchCurrentWeekStart,
  fetchDepartments,
  fetchWeeks,
} from "./api";
import { siddurKeys } from "./queryKeys";

// The ride-change/passenger-list/notes/driver-claim mutations (and `useRideChanges`) moved to
// `src/features/rides/hooks.ts` along with their `api.ts` functions (R8: break the siddur ⇄
// sadran import cycle) — they are shared by both the siddur and sadran board, not siddur-specific.

export function useMyUpcomingRides() {
  const { departmentId } = useActiveDepartment();
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({
    queryKey: siddurKeys.myUpcomingRides(profileId, departmentId),
    queryFn: () => fetchMyUpcomingRides(profileId as string, departmentId),
    enabled: !!profileId,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useDepartments() {
  return useQuery({
    queryKey: siddurKeys.departments(),
    queryFn: fetchDepartments,
    staleTime: 10 * 60_000,
  });
}

export function useCurrentWeekStart() {
  return useQuery({
    queryKey: siddurKeys.currentWeekStart(),
    queryFn: fetchCurrentWeekStart,
    staleTime: 60_000,
  });
}

export function useWeeks(departmentId: string | undefined) {
  return useQuery({
    queryKey: siddurKeys.weeks(departmentId),
    queryFn: () => fetchWeeks(departmentId as string),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
}

/** My children (`child_guardians`); needed only by the "children's rides" display option. */
export function useMyChildrenQuery(enabled: boolean) {
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({
    queryKey: siddurKeys.myChildren(profileId),
    queryFn: () => fetchMyChildren(profileId as string),
    enabled: enabled && !!profileId,
    staleTime: 5 * 60_000,
  });
}

/** Upcoming rides with one of my children on them — read-only extras of `/my` (owner 2026-10-16). */
export function useMyChildrenRidesQuery(childIds: readonly string[], enabled: boolean) {
  const { departmentId } = useActiveDepartment();
  return useQuery({
    queryKey: siddurKeys.myChildrenRides(departmentId, childIds),
    queryFn: () => fetchMyChildrenRides(childIds, departmentId),
    enabled: enabled && childIds.length > 0,
    staleTime: 30_000,
  });
}

export function useBoardRides(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: siddurKeys.boardRides(departmentId as string, weekStart as string),
    queryFn: () => fetchBoardRides(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 30_000,
  });
}

export function useBoardRideById(rideId: string | undefined) {
  return useQuery({
    queryKey: siddurKeys.boardRideById(rideId),
    queryFn: () => fetchBoardRideById(rideId as string),
    enabled: !!rideId,
  });
}

export function useCarForRide(carId: string | undefined) {
  return useQuery({
    queryKey: siddurKeys.carForRide(carId),
    queryFn: () => fetchCarForRide(carId as string),
    enabled: !!carId,
  });
}

export function useCarLocations(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: siddurKeys.carLocations(departmentId, weekStart),
    queryFn: () => fetchCarLocations(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 30_000,
  });
}

/** Where each car stands at the week's start (`car_start_locations()`), car id -> place id. */
export function useCarStartLocations(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: siddurKeys.carStartLocations(departmentId, weekStart),
    queryFn: () => fetchCarStartLocationIds(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 30_000,
  });
}
