import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { siddurKeys } from "@/features/siddur/queryKeys";
import { sadranKeys } from "@/features/sadran/keys";
import { useSession } from "@/features/auth/useSession";
import { showErrorToast } from "@/lib/rpc";

import {
  cancelRide,
  claimFreedSlot,
  fetchMyFreedSlotOffers,
  fetchMyRequests,
  fetchRequestById,
  fetchRequestCompanionIds,
  fetchRequestChildIds,
  setFreedSlotOptOut,
  setRequestCompanions,
  setRequestChildren,
  submitRequest,
  withdrawFreedSlotClaim,
  withdrawRequest,
  withdrawAllRequests,
  type SubmitRequestPayload,
} from "./api";
import { requestsKeys } from "./queryKeys";

export function useMyRequests() {
  const { departmentId } = useActiveDepartment();
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: [...requestsKeys.mine(profileId), departmentId],
    queryFn: () => fetchMyRequests(profileId as string, departmentId),
    enabled: !!profileId && !!departmentId,
    staleTime: 30_000,
  });
}

export function useSubmitRequestMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: SubmitRequestPayload) => submitRequest(payload),
    onSuccess: (_result, payload) => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
      queryClient.invalidateQueries({ queryKey: ["siddur", "myUpcomingRides"] });
      if (payload.request_id) queryClient.invalidateQueries({ queryKey: requestsKeys.byId(payload.request_id) });
      queryClient.invalidateQueries({ queryKey: sadranKeys.week(payload.department_id, payload.week_start) });
      queryClient.invalidateQueries({ queryKey: siddurKeys.boardRides(payload.department_id, payload.week_start) });
      queryClient.invalidateQueries({ queryKey: siddurKeys.carLocations(payload.department_id, payload.week_start) });
    },
    onError: showErrorToast,
  });
}

export function useWithdrawRequestMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ requestId, expectedVersion }: { requestId: string; expectedVersion: number }) =>
      withdrawRequest(requestId, expectedVersion),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
      queryClient.invalidateQueries({ queryKey: ["siddur"] });
      queryClient.invalidateQueries({ queryKey: ["sadran"] });
    },
    onError: showErrorToast,
  });
}

export function useCancelRideMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      rideId,
      reason,
      expectedVersion,
    }: {
      rideId: string;
      reason: string;
      expectedVersion?: number;
    }) => cancelRide(rideId, reason, expectedVersion),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
      queryClient.invalidateQueries({ queryKey: ["siddur"] });
      queryClient.invalidateQueries({ queryKey: ["sadran"] });
    },
    onError: showErrorToast,
  });
}

/** A single request for the edit form (`/requests/:id/edit`). */
export function useRequestQuery(requestId: string | undefined) {
  const { session } = useSession();
  const profileId = session?.user.id;
  return useQuery({
    queryKey: [...requestsKeys.byId(requestId), profileId],
    queryFn: () => fetchRequestById(requestId as string, profileId as string),
    enabled: !!requestId && !!profileId,
  });
}

export function useRequestCompanionsQuery(requestId: string | undefined) {
  return useQuery({
    queryKey: requestsKeys.companions(requestId),
    queryFn: () => fetchRequestCompanionIds(requestId as string),
    enabled: !!requestId,
  });
}

export function useRequestChildrenQuery(requestId: string | undefined) {
  return useQuery({
    queryKey: [...requestsKeys.companions(requestId), "children"],
    queryFn: () => fetchRequestChildIds(requestId as string),
    enabled: !!requestId,
  });
}

export function useSetRequestCompanionsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, profileIds }: { requestId: string; profileIds: string[] }) =>
      setRequestCompanions(requestId, profileIds),
    onSuccess: () => {
      for (const key of ["siddur", "sadran", "requests"]) void queryClient.invalidateQueries({ queryKey: [key] });
    },
    onError: showErrorToast,
  });
}

export function useSetRequestChildrenMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, childIds }: { requestId: string; childIds: string[] }) => setRequestChildren(requestId, childIds),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["requests"] }); },
    onError: showErrorToast,
  });
}

/** Freed-slot offers addressed to me (My requests list — "אני עדיין רוצה"). */
export function useMyFreedSlotOffers() {
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: requestsKeys.freedOffers(profileId),
    queryFn: () => fetchMyFreedSlotOffers(profileId as string),
    enabled: !!profileId,
    staleTime: 15_000,
  });
}

export function useClaimFreedSlotMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ offerId, requestId }: { offerId: string; requestId: string }) =>
      claimFreedSlot(offerId, requestId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.freedOffers(profileId) });
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
    },
    onError: showErrorToast,
  });
}

/** Owner (or Sadran) toggles "don't offer me freed slots" on an existing request. */
export function useSetFreedSlotOptOutMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ requestId, optOut }: { requestId: string; optOut: boolean }) =>
      setFreedSlotOptOut(requestId, optOut),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
    },
    onError: showErrorToast,
  });
}

export function useWithdrawFreedSlotClaimMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ offerId, requestId }: { offerId: string; requestId: string }) =>
      withdrawFreedSlotClaim(offerId, requestId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.freedOffers(profileId) });
    },
    onError: showErrorToast,
  });
}

export function useWithdrawAllRequestsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ departmentId, weekStart }: { departmentId: string; weekStart: string }) =>
      withdrawAllRequests(departmentId, weekStart),
    onSuccess: (_result, { departmentId, weekStart }) => {
      void queryClient.invalidateQueries({ queryKey: ["requests"] });
      void queryClient.invalidateQueries({ queryKey: ["siddur", "myUpcomingRides"] });
      void queryClient.invalidateQueries({ queryKey: sadranKeys.week(departmentId, weekStart) });
      void queryClient.invalidateQueries({ queryKey: siddurKeys.boardRides(departmentId, weekStart) });
      void queryClient.invalidateQueries({ queryKey: siddurKeys.carLocations(departmentId, weekStart) });
    },
    onError: showErrorToast,
  });
}
