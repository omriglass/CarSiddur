import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/features/auth/useSession";
import { showErrorToast } from "@/lib/rpc";

import {
  fetchBoardRideById,
  fetchMyUpcomingRides,
  fetchBoardRides,
  fetchBoardStartTime,
  fetchCarForRide,
  fetchCarLocations,
  fetchCurrentWeekStart,
  fetchDepartments,
  fetchOpenAndLiveWeekStarts,
  fetchWeeks,
  fetchRideChanges,
  requestRideChange,
  respondRideChange,
  cancelRideChange,
  claimRideDriver,
  updateRidePublicNotes,
  type RideMove,
} from "./api";
import { siddurKeys } from "./queryKeys";

export function useMyUpcomingRides() {
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({
    queryKey: ["siddur", "myUpcomingRides", profileId],
    queryFn: () => fetchMyUpcomingRides(profileId as string),
    enabled: !!profileId,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

export function useUpdateRidePublicNotesMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ rideId, expectedVersion, notes }: { rideId: string; expectedVersion: number; notes: string | null }) =>
      updateRidePublicNotes(rideId, expectedVersion, notes),
    onSuccess: () => {
      for (const key of ["siddur", "sadran", "requests"]) void client.invalidateQueries({ queryKey: [key] });
    },
    onError: showErrorToast,
  });
}

export function useClaimRideDriverMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ rideId, expectedVersion }: { rideId: string; expectedVersion: number }) => claimRideDriver(rideId, expectedVersion),
    onSuccess: () => {
      for (const key of ["siddur", "sadran", "requests", "inbox"]) void client.invalidateQueries({ queryKey: [key] });
    },
    onError: showErrorToast,
  });
}

export function useRideChanges(departmentId?: string, weekStart?: string) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["siddur", "rideChanges", session?.user.id, departmentId, weekStart],
    queryFn: () => fetchRideChanges(departmentId, weekStart),
    enabled: !!session,
    refetchInterval: 15_000,
  });
}

export function useRequestRideChangeMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (move: RideMove) => requestRideChange(move),
    onSuccess: () => client.invalidateQueries({ queryKey: ["siddur"] }),
    onError: showErrorToast,
  });
}

export function useRespondRideChangeMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ changeId, accept }: { changeId: string; accept: boolean }) => respondRideChange(changeId, accept),
    onSuccess: () => {
      for (const key of ["siddur", "sadran", "requests", "inbox"]) void client.invalidateQueries({ queryKey: [key] });
    },
    onError: showErrorToast,
  });
}

export function useCancelRideChangeMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: cancelRideChange,
    onSuccess: () => {
      for (const key of ["siddur", "sadran", "inbox"]) void client.invalidateQueries({ queryKey: [key] });
    },
    onError: showErrorToast,
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
