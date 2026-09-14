import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/features/auth/useSession";
import { inboxKeys } from "@/features/inbox/queryKeys";
import { requestsKeys } from "@/features/requests/queryKeys";
import { sadranKeys } from "@/features/sadran/keys";
import { showErrorToast } from "@/lib/rpc";

import {
  addRidePassengers,
  fetchBoardRideById,
  fetchMyUpcomingRides,
  fetchBoardRides,
  fetchCarForRide,
  fetchCarLocations,
  fetchCurrentWeekStart,
  fetchDepartments,
  fetchWeeks,
  fetchRideChanges,
  removeRidePassenger,
  requestRideChange,
  respondRideChange,
  cancelRideChange,
  claimRideDriver,
  updateRidePublicNotes,
  type RideMove,
  type RidePassengerInput,
} from "./api";
import { siddurKeys } from "./queryKeys";

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

export function useUpdateRidePublicNotesMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ rideId, expectedVersion, notes }: { rideId: string; expectedVersion: number; notes: string | null }) =>
      updateRidePublicNotes(rideId, expectedVersion, notes),
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, requestsKeys.all]) void client.invalidateQueries({ queryKey: key });
    },
    onError: showErrorToast,
  });
}

/**
 * The "+ נוסעים" button — appends named passengers to a published ride (siddur
 * `RideDetailSheet` and, reused, the board's `RideSheet`). Invalidates the same three
 * feature roots as `useUpdateRidePublicNotesMutation` above: the ride's own passenger list
 * lives on `v_board_rides.passengers`, read by both the siddur and the board.
 */
export function useAddRidePassengersMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ rideId, expectedVersion, passengers }: { rideId: string; expectedVersion: number; passengers: RidePassengerInput[] }) =>
      addRidePassengers(rideId, expectedVersion, passengers),
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, requestsKeys.all]) void client.invalidateQueries({ queryKey: key });
    },
    onError: showErrorToast,
  });
}

export function useRemoveRidePassengerMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ridePassengerId, expectedVersion }: { ridePassengerId: string; expectedVersion: number }) =>
      removeRidePassenger(ridePassengerId, expectedVersion),
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, requestsKeys.all]) void client.invalidateQueries({ queryKey: key });
    },
    onError: showErrorToast,
  });
}

export function useClaimRideDriverMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ rideId, expectedVersion }: { rideId: string; expectedVersion: number }) => claimRideDriver(rideId, expectedVersion),
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, requestsKeys.all, inboxKeys.all])
        void client.invalidateQueries({ queryKey: key });
    },
    onError: showErrorToast,
  });
}

export function useRideChanges(departmentId?: string, weekStart?: string) {
  const { session } = useSession();
  return useQuery({
    queryKey: siddurKeys.rideChanges(session?.user.id, departmentId, weekStart),
    queryFn: () => fetchRideChanges(departmentId, weekStart),
    enabled: !!session,
    refetchInterval: 15_000,
  });
}

export function useRequestRideChangeMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (move: RideMove) => requestRideChange(move),
    onSuccess: () => client.invalidateQueries({ queryKey: siddurKeys.all }),
    onError: showErrorToast,
  });
}

export function useRespondRideChangeMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ changeId, accept }: { changeId: string; accept: boolean }) => respondRideChange(changeId, accept),
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, requestsKeys.all, inboxKeys.all])
        void client.invalidateQueries({ queryKey: key });
    },
    onError: showErrorToast,
  });
}

export function useCancelRideChangeMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: cancelRideChange,
    onSuccess: () => {
      for (const key of [siddurKeys.all, sadranKeys.all, inboxKeys.all]) void client.invalidateQueries({ queryKey: key });
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
