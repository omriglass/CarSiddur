import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useQuery } from "@tanstack/react-query";
import { contextKeys } from "@/features/auth/queryKeys";
import { useSession } from "@/features/auth/useSession";

import {
  fetchBoardRideById,
  fetchMyChildren,
  fetchMyChildrenRides,
  fetchMyCoGuardianIds,
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
  const { departmentId, isLoading: departmentLoading } = useActiveDepartment();
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({
    queryKey: siddurKeys.myUpcomingRides(profileId, departmentId),
    queryFn: () => fetchMyUpcomingRides(profileId as string, departmentId),
    // The department is undefined until its queries land; fetching (and keying) before that ran the whole fetch twice.
    enabled: !!profileId && !departmentLoading,
    // No timer (REQ item 149): /my watches its weeks' change counters (`useWeekChangeWatch`) and refreshes on a change.
  });
}

/** Same query (and cache entry) as `useActiveDepartment`'s department list: one fetch per session. */
export function useDepartments() {
  const { session } = useSession();
  return useQuery({
    queryKey: contextKeys.departments(session?.user.id),
    queryFn: fetchDepartments,
    enabled: !!session,
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
export function useMyChildrenRidesQuery(childIds: readonly string[], enabled: boolean, guardianIds: readonly string[] = []) {
  const { departmentId } = useActiveDepartment();
  return useQuery({
    queryKey: siddurKeys.myChildrenRides(departmentId, childIds, guardianIds),
    queryFn: () => fetchMyChildrenRides(childIds, departmentId, guardianIds),
    enabled: enabled && childIds.length > 0,
    staleTime: 30_000,
  });
}

/** The other guardians of my children (REQ §13.134); fetched only with the "children's rides" option on. */
export function useMyCoGuardiansQuery(enabled: boolean) {
  const { departmentId } = useActiveDepartment();
  return useQuery({
    queryKey: siddurKeys.myCoGuardians(departmentId),
    queryFn: () => fetchMyCoGuardianIds(departmentId as string),
    enabled: enabled && !!departmentId,
    staleTime: 5 * 60_000,
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
