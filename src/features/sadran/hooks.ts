import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchCars } from "@/features/fleet/api";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { requestsKeys } from "@/features/requests/queryKeys";
import { showErrorToast } from "@/lib/rpc";

import * as api from "./api";
import { sadranKeys } from "./keys";
import { publishWithScores } from "./publish/publishWithScores";

import type { Database, Json } from "@/integrations/supabase/types";

// ---------------------------------------------------------------------------
// Week / phase
// ---------------------------------------------------------------------------

export function useWeekRow(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.weekRow(departmentId ?? "", weekStart ?? ""),
    queryFn: () => api.fetchWeekRow(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Requests / board reads
// ---------------------------------------------------------------------------

/**
 * `api.fetchWeekRequests` plus requester/destination/ride-type names (bug #1:
 * the board's `UnmetList` and the dashboard's counters need to show *which*
 * request is unmet straight from the DB, not only from a solver run).
 */
export function useWeekRequestsWithNames(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.weekRequestsWithNames(departmentId ?? "", weekStart ?? ""),
    queryFn: () => api.fetchWeekRequestsWithNames(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 10_000,
  });
}

/** Reuses `@/features/fleet/api`'s `fetchCars` (already department-scoped, excludes retired). */
export function useCarsForDepartment(departmentId: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.cars(departmentId ?? ""),
    queryFn: () => fetchCars(departmentId as string),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
}

export function useDepartmentSettings(departmentId: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.departmentSettings(departmentId ?? ""),
    queryFn: () => api.fetchDepartmentSettings(departmentId as string),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
}

export function useMaintenanceBlocks(departmentId: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.maintenanceBlocks(departmentId ?? ""),
    queryFn: () => api.fetchMaintenanceBlocksForDepartment(departmentId as string),
    enabled: !!departmentId,
    staleTime: 30_000,
  });
}

export function useActivePolicy(departmentId: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.activePolicy(departmentId ?? ""),
    queryFn: () => api.fetchActivePolicy(departmentId as string),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
}

export function usePolicyOptions(departmentId: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.policyOptions(departmentId ?? ""),
    queryFn: () => api.fetchPolicyOptions(departmentId as string),
    enabled: !!departmentId,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Solver runs
// ---------------------------------------------------------------------------

export function useLatestSolverRun(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.solverRuns(departmentId ?? "", weekStart ?? ""),
    queryFn: () => api.fetchLatestSolverRun(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 5_000,
  });
}

function invalidateBoard(queryClient: ReturnType<typeof useQueryClient>, departmentId: string, weekStart: string) {
  queryClient.invalidateQueries({ queryKey: sadranKeys.week(departmentId, weekStart) });
  queryClient.invalidateQueries({ queryKey: siddurKeys.all });
  queryClient.invalidateQueries({ queryKey: requestsKeys.all });
}

export function useRecordSolverPreviewMutation() {
  return useMutation({
    mutationFn: ({ departmentId, weekStart, payload }: { departmentId: string; weekStart: string; payload: Json }) =>
      api.recordSolverPreview(departmentId, weekStart, payload),
    onError: showErrorToast,
  });
}

export function useApplySolverResultMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ departmentId, weekStart, payload }: { departmentId: string; weekStart: string; payload: Json }) =>
      api.applySolverResult(departmentId, weekStart, payload),
    onSuccess: (_data, { departmentId, weekStart }) => invalidateBoard(queryClient, departmentId, weekStart),
    onError: showErrorToast,
  });
}

// ---------------------------------------------------------------------------
// Single-ride edits
// ---------------------------------------------------------------------------

export function useEditRideMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      input,
      expectedVersion,
    }: {
      input: api.EditRideInput;
      expectedVersion?: number;
      departmentId: string;
      weekStart: string;
    }) => api.editRide(input, expectedVersion),
    onSuccess: (_data, { departmentId, weekStart }) => invalidateBoard(queryClient, departmentId, weekStart),
    onError: showErrorToast,
  });
}

export function useCancelRideMutation() {
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
      departmentId: string;
      weekStart: string;
    }) => api.cancelRide(rideId, reason, expectedVersion),
    onSuccess: (_data, { departmentId, weekStart }) => invalidateBoard(queryClient, departmentId, weekStart),
    onError: showErrorToast,
  });
}

export function useUnassignRideMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rideId, expectedVersion }: {
      rideId: string; expectedVersion: number; departmentId: string; weekStart: string;
    }) => api.unassignRide(rideId, expectedVersion),
    onSuccess: (_data, { departmentId, weekStart }) => invalidateBoard(queryClient, departmentId, weekStart),
    onError: showErrorToast,
  });
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export function useProposalsForWeek(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.proposals(departmentId ?? "", weekStart ?? ""),
    queryFn: () => api.fetchProposalsForWeek(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 10_000,
  });
}

export function useProposalParties(proposalId: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.proposalParties(proposalId ?? ""),
    queryFn: () => api.fetchProposalParties(proposalId as string),
    enabled: !!proposalId,
    staleTime: 10_000,
  });
}

export function useProfilesByIds(profileIds: readonly string[]) {
  const key = [...profileIds].sort().join(",");
  return useQuery({
    queryKey: sadranKeys.profilesByIds(key),
    queryFn: () => api.fetchProfilesByIds([...profileIds]),
    enabled: profileIds.length > 0,
    staleTime: 60_000,
  });
}

export function useWhatsappTemplates() {
  return useQuery({
    queryKey: sadranKeys.whatsappTemplates(),
    queryFn: api.fetchWhatsappTemplates,
    staleTime: 5 * 60_000,
  });
}

export function useCreateProposalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.CreateProposalInput) => api.createProposal(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sadranKeys.all }),
    onError: showErrorToast,
  });
}

export function useSendProposalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      proposalId,
      sentVia,
      replacement,
    }: {
      proposalId: string;
      sentVia?: Database["public"]["Enums"]["notification_channel"][];
      replacement?: { id: string; version: number };
      departmentId: string;
      weekStart: string;
    }) => api.sendProposal(proposalId, sentVia, replacement),
    // Also refresh after failures: another coordinator may have sent/answered the
    // proposal, or the server may have committed before the connection dropped.
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: sadranKeys.all }),
      queryClient.invalidateQueries({ queryKey: siddurKeys.all }),
      queryClient.invalidateQueries({ queryKey: requestsKeys.all }),
    ]),
    onError: showErrorToast,
  });
}

export function useRecordAnswerOnBehalfMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      proposalId,
      profileId,
      accept,
      note,
    }: {
      proposalId: string;
      profileId: string;
      accept: boolean;
      note?: string;
      departmentId: string;
      weekStart: string;
    }) => api.recordAnswerOnBehalf(proposalId, profileId, accept, note),
    onSuccess: (_data, { proposalId, departmentId, weekStart }) => {
      invalidateBoard(queryClient, departmentId, weekStart);
      queryClient.invalidateQueries({ queryKey: sadranKeys.proposals(departmentId, weekStart) });
      queryClient.invalidateQueries({ queryKey: sadranKeys.proposalParties(proposalId) });
    },
    onError: showErrorToast,
  });
}

export function useApplyProposalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ proposalId }: { proposalId: string; departmentId: string; weekStart: string }) =>
      api.applyProposal(proposalId),
    onSuccess: (_data, { departmentId, weekStart }) => invalidateBoard(queryClient, departmentId, weekStart),
    onError: showErrorToast,
  });
}

// ---------------------------------------------------------------------------
// Contested freed slots
// ---------------------------------------------------------------------------

export function useFreedOffersForWeek(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.freedOffers(departmentId ?? "", weekStart ?? ""),
    queryFn: () => api.fetchFreedOffersForWeek(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 15_000,
  });
}

export function useClaimsForOffer(offerId: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.freedClaims(offerId ?? ""),
    queryFn: () => api.fetchClaimsForOffer(offerId as string),
    enabled: !!offerId,
    staleTime: 10_000,
  });
}

export function useApproveClaimMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ offerId, requestId }: { offerId: string; requestId: string; departmentId: string; weekStart: string }) =>
      api.approveClaim(offerId, requestId),
    onSuccess: (_data, { departmentId, weekStart }) => invalidateBoard(queryClient, departmentId, weekStart),
    onError: showErrorToast,
  });
}

export function useCloseOfferMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ offerId }: { offerId: string; departmentId: string; weekStart: string }) => api.closeOffer(offerId),
    onSuccess: (_data, { departmentId, weekStart }) => invalidateBoard(queryClient, departmentId, weekStart),
    onError: showErrorToast,
  });
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export function useSiddurVersions(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.siddurVersions(departmentId ?? "", weekStart ?? ""),
    queryFn: () => api.fetchSiddurVersions(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 15_000,
  });
}

export function useAllWeekRides(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.boardRides(departmentId ?? "", weekStart ?? ""),
    queryFn: () => api.fetchAllWeekRides(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 10_000,
  });
}

export function usePublishSiddurMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ departmentId, weekStart, days, allowUnanswered }: { departmentId: string; weekStart: string; days?: string[]; allowUnanswered?: boolean }) =>
      publishWithScores(departmentId, weekStart, { days, allowUnanswered }),
    onSuccess: (_data, { departmentId, weekStart }) => {
      invalidateBoard(queryClient, departmentId, weekStart);
      queryClient.invalidateQueries({ queryKey: sadranKeys.siddurVersions(departmentId, weekStart) });
    },
    onError: showErrorToast,
  });
}

export function usePublicationReadiness(departmentId: string, weekStart: string) {
  return useQuery({
    queryKey: sadranKeys.publicationReadiness(departmentId, weekStart),
    queryFn: () => api.fetchPublicationReadiness(departmentId, weekStart),
    enabled: !!departmentId && !!weekStart,
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}

export function useReopenWeekMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ departmentId, weekStart, phase, expectedFingerprint }: { departmentId: string; weekStart: string; phase: "open" | "solving"; expectedFingerprint: string }) =>
      api.reopenWeek(departmentId, weekStart, phase, expectedFingerprint),
    onSuccess: (_data, { departmentId, weekStart }) => invalidateBoard(queryClient, departmentId, weekStart),
    onError: showErrorToast,
  });
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------

export function useAuditLog(departmentId: string | undefined, weekStart: string | undefined) {
  return useQuery({
    queryKey: sadranKeys.auditLog(departmentId ?? "", weekStart ?? ""),
    queryFn: () => api.fetchAuditLog(departmentId as string, weekStart as string),
    enabled: !!departmentId && !!weekStart,
    staleTime: 15_000,
  });
}
