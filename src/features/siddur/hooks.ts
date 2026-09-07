import { useQuery } from "@tanstack/react-query";

import {
  fetchBoardRideById,
  fetchBoardRides,
  fetchBoardStartTime,
  fetchCarForRide,
  fetchCarLocations,
  fetchCurrentWeekStart,
  fetchDepartments,
  fetchOpenAndLiveWeekStarts,
  fetchWeeks,
} from "./api";
import { siddurKeys } from "./queryKeys";

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

export function useOpenAndLiveWeekStarts(departmentId: string | undefined) {
  return useQuery({
    queryKey: siddurKeys.openLiveWeekStarts(departmentId as string),
    queryFn: () => fetchOpenAndLiveWeekStarts(departmentId as string),
    enabled: !!departmentId,
    staleTime: 60_000,
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

/** The member grid's default visible-range start (UX_FLOWS.md §20). */
export function useBoardStartTime(departmentId: string | undefined) {
  return useQuery({
    queryKey: siddurKeys.boardStartTime(departmentId),
    queryFn: () => fetchBoardStartTime(departmentId as string),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
}
