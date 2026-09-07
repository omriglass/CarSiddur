import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showErrorToast } from "@/lib/rpc";

import { answerProposal, answerProposalViaToken, fetchProposalSummary, type AnswerProposalInput } from "./api";
import { proposalsKeys } from "./queryKeys";

/** In-app answer (a session exists) — `answer_proposal` RPC directly. */
export function useAnswerProposalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AnswerProposalInput) => answerProposal(input),
    onSettled: () => Promise.all(["sadran", "siddur", "requests"].map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
    onError: showErrorToast,
  });
}

/** `/p/:token` summary — no session required (ARCHITECTURE §8). */
export function useProposalSummaryQuery(token: string | undefined) {
  return useQuery({
    queryKey: proposalsKeys.byToken(token),
    queryFn: () => fetchProposalSummary(token as string),
    enabled: !!token,
    retry: false,
  });
}

/** `/p/:token` answer via the public edge function (works with or without a session). */
export function useAnswerProposalViaTokenMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      token,
      answer,
      note,
      optOut,
    }: {
      token: string;
      answer: "accepted" | "declined";
      note?: string;
      optOut?: boolean;
    }) => answerProposalViaToken(token, answer, note, optOut),
    onSettled: () => Promise.all(["sadran", "siddur", "requests"].map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
  });
}
