import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/features/auth/useSession";
import { requestsKeys } from "@/features/requests/queryKeys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { showErrorToast } from "@/lib/rpc";

import {
  answerProposal,
  answerProposalViaToken,
  fetchProposalSummary,
  fetchSadranContact,
  type AnswerProposalInput,
} from "./api";
import { proposalsKeys } from "./queryKeys";

/** In-app answer (a session exists) — `answer_proposal` RPC directly. */
export function useAnswerProposalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AnswerProposalInput) => answerProposal(input),
    onSettled: () =>
      Promise.all(
        [sadranKeys.all, siddurKeys.all, requestsKeys.all].map((key) => queryClient.invalidateQueries({ queryKey: key })),
      ),
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

/**
 * `/p/:token`'s "talk to the sadran on WhatsApp" button (UX_FLOWS.md §3.6).
 * Requires a session (`sadran_contact_of` is `is_approved()`-gated) *and*
 * both `departmentId`/`weekStart` — pass `undefined` for either and the
 * query stays disabled, which is what `ProposalTokenPage.tsx` does today
 * pending the gap documented on `fetchSadranContact` in `./api.ts`. Also
 * disabled (button hidden) on `not_authorized`/any RPC error, since `retry`
 * is off and callers should just treat empty/error the same as "no contact".
 */
export function useSadranContactQuery(departmentId: string | undefined, weekStart: string | undefined) {
  const { session } = useSession();
  return useQuery({
    queryKey: proposalsKeys.sadranContact(departmentId, weekStart),
    queryFn: () => fetchSadranContact(departmentId as string, weekStart as string),
    enabled: !!session && !!departmentId && !!weekStart,
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
    onSettled: () =>
      Promise.all(
        [sadranKeys.all, siddurKeys.all, requestsKeys.all].map((key) => queryClient.invalidateQueries({ queryKey: key })),
      ),
  });
}
