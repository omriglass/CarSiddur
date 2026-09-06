import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";
import { showErrorToast } from "@/lib/rpc";

import {
  cancelRide,
  claimFreedSlot,
  fetchMyFreedSlotOffers,
  fetchMyRequests,
  fetchRequestById,
  fetchRequestCompanionIds,
  setFreedSlotOptOut,
  setRequestCompanions,
  submitRequest,
  withdrawFreedSlotClaim,
  withdrawRequest,
  type SubmitRequestPayload,
} from "./api";
import { requestsKeys } from "./queryKeys";

export function useMyRequests() {
  const { session } = useSession();
  const profileId = session?.user.id;

  return useQuery({
    queryKey: requestsKeys.mine(profileId),
    queryFn: () => fetchMyRequests(profileId as string),
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

export function useSubmitRequestMutation() {
  const { session } = useSession();
  const profileId = session?.user.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: SubmitRequestPayload) => submitRequest(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: requestsKeys.mine(profileId) });
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
    },
    onError: showErrorToast,
  });
}

/** A single request for the edit form (`/requests/:id/edit`). */
export function useRequestQuery(requestId: string | undefined) {
  return useQuery({
    queryKey: requestsKeys.byId(requestId),
    queryFn: () => fetchRequestById(requestId as string),
    enabled: !!requestId,
  });
}

export function useRequestCompanionsQuery(requestId: string | undefined) {
  return useQuery({
    queryKey: requestsKeys.companions(requestId),
    queryFn: () => fetchRequestCompanionIds(requestId as string),
    enabled: !!requestId,
  });
}

export function useSetRequestCompanionsMutation() {
  return useMutation({
    mutationFn: ({ requestId, profileIds }: { requestId: string; profileIds: string[] }) =>
      setRequestCompanions(requestId, profileIds),
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
