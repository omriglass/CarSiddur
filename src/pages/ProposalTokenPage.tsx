import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSession } from "@/features/auth/useSession";
import { ProposalFetchError, type ProposalSummary } from "@/features/proposals/api";
import { ProposalSummary as ProposalSummaryView } from "@/features/proposals/components/ProposalSummary";
import {
  useAnswerProposalMutation,
  useAnswerProposalViaTokenMutation,
  useProposalSummaryQuery,
  useSadranContactQuery,
} from "@/features/proposals/hooks";
import { classifyProposalScreenState } from "@/features/proposals/screenState";
import { useSetFreedSlotOptOutMutation } from "@/features/requests/hooks";
import { buildWaUrl } from "@/features/sadran/proposals/waLink";
import { he, t, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

const ERROR_COPY: Record<string, string> = {
  invalid_token: he.proposalScreen.notFound,
  expired: he.proposalScreen.expired,
  rate_limited: he.proposalScreen.rateLimited,
  unknown: he.proposalScreen.genericError,
};

function BeforeAfterBox({ label, depart, ret }: { label: string; depart: string | null; ret: string | null }) {
  return (
    <div className="flex-1 rounded-md border p-3 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p dir="ltr" className="font-medium tabular-nums">
        {depart ? formatTime(new Date(depart)) : "—"}
        {" → "}
        {ret ? formatTime(new Date(ret)) : "—"}
      </p>
    </div>
  );
}

interface ShiftPayload {
  depart_at?: string;
  return_at?: string;
  starts_at?: string;
  ends_at?: string;
}

function readShiftPayload(payload: unknown): ShiftPayload {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  return {
    depart_at: typeof record.depart_at === "string" ? record.depart_at : undefined,
    return_at: typeof record.return_at === "string" ? record.return_at : undefined,
    starts_at: typeof record.starts_at === "string" ? record.starts_at : undefined,
    ends_at: typeof record.ends_at === "string" ? record.ends_at : undefined,
  };
}

/**
 * `/p/:token` — proposal answer screen (UX_FLOWS.md §3.6). Works without a
 * session: fetches via the public `answer-proposal` edge function. When a
 * session exists, the in-app path answers through the `answer_proposal` RPC
 * directly instead (ARCHITECTURE §8).
 *
 * Owner decision: a proposal is either accepted or declined — anything else
 * ("suggest another time", a free-text note) is a WhatsApp conversation with
 * the Sadran instead, so this screen offers no note field of its own.
 */
export function ProposalTokenPage() {
  const { token } = useParams<{ token: string }>();
  const { session } = useSession();

  const summaryQuery = useProposalSummaryQuery(token);
  const answerViaRpc = useAnswerProposalMutation();
  const answerViaToken = useAnswerProposalViaTokenMutation();
  const optOutMutation = useSetFreedSlotOptOutMutation();

  /**
   * "Talk to the sadran on WhatsApp" (UX_FLOWS.md §3.6) via `sadran_contact_of`. The `/p/:token`
   * summary now carries the proposal's own `departmentId`/`weekStart` (`answer-proposal/index.ts`'s
   * `buildSummary()`, `@/features/proposals/api.ts`'s `ProposalSummary`), so this is live for a
   * signed-in member; `useSadranContactQuery` itself stays disabled without a session (its own
   * `enabled` check), which is what keeps the button hidden for a no-session token visitor.
   */
  const sadranContactQuery = useSadranContactQuery(
    summaryQuery.data?.departmentId,
    summaryQuery.data?.weekStart,
  );
  const sadranPhone = sadranContactQuery.data?.[0]?.phone ?? null;

  const [justAnswered, setJustAnswered] = useState<"accepted" | "declined" | null>(null);
  const [optOutFreed, setOptOutFreed] = useState(false);

  const errorCode = summaryQuery.error instanceof ProposalFetchError ? summaryQuery.error.code : summaryQuery.error ? "unknown" : null;
  const state = classifyProposalScreenState({
    isLoading: summaryQuery.isLoading,
    errorCode,
    summary: summaryQuery.data,
    justAnswered: !!justAnswered,
  });

  const isDenyVariant = state.kind === "answerable" && (state.summary.type === "deny" || state.summary.type === "external");

  /**
   * Stage 3 hardening fix #3: the deny/external variant's freed-slot opt-out checkbox used
   * to be UI-only (UX_FLOWS.md §14 item 3). With a session, the requester's own signed-in
   * identity satisfies `set_freed_slot_opt_out`'s owner check directly; without one (the
   * common WhatsApp-link case, ARCHITECTURE §8), the token itself is the credential, so the
   * flag rides along in the same POST the edge function already makes and it applies the
   * update with the service role (`supabase/functions/answer-proposal/index.ts`).
   */
  async function submitAnswer(answer: "accepted" | "declined") {
    if (!token) return;
    if (session) {
      await answerViaRpc.mutateAsync({ token, accept: answer === "accepted", via: "session" });
      if (isDenyVariant && state.kind === "answerable" && state.summary.request) {
        await optOutMutation.mutateAsync({ requestId: state.summary.request.id, optOut: optOutFreed });
      }
    } else {
      await answerViaToken.mutateAsync({
        token,
        answer,
        optOut: isDenyVariant ? optOutFreed : undefined,
      });
    }
    setJustAnswered(answer);
  }

  return (
    <div className="mx-auto max-w-md p-4">
      <Card>
        <CardHeader>
          <CardTitle>{he.app.name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.kind === "loading" ? <p className="text-muted-foreground">{t("proposalScreen.loading")}</p> : null}

          {state.kind === "error" ? <p className="text-destructive">{ERROR_COPY[state.code]}</p> : null}

          {state.kind === "answered" ? (
            <div className="space-y-3">
              <p className="font-medium">{he.proposalScreen.confirmedTitle}</p>
              {!justAnswered ? <p className="text-sm text-muted-foreground">{he.proposalScreen.alreadyAnsweredBy}</p> : null}
              <Button asChild variant="outline">
                <Link to="/my">{he.proposalScreen.backHome}</Link>
              </Button>
            </div>
          ) : null}

          {state.kind === "answerable" ? (
            <ProposalAnswerBody
              summary={state.summary}
              sadranPhone={sadranPhone}
              optOutFreed={optOutFreed}
              onOptOutFreedChange={setOptOutFreed}
              onAccept={() => submitAnswer("accepted")}
              onDecline={() => submitAnswer("declined")}
              isSubmitting={answerViaRpc.isPending || answerViaToken.isPending}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

interface ProposalAnswerBodyProps {
  summary: ProposalSummary;
  sadranPhone: string | null;
  optOutFreed: boolean;
  onOptOutFreedChange: (checked: boolean) => void;
  onAccept: () => void;
  onDecline: () => void;
  isSubmitting: boolean;
}

function ProposalAnswerBody({
  summary,
  sadranPhone,
  optOutFreed,
  onOptOutFreedChange,
  onAccept,
  onDecline,
  isSubmitting,
}: ProposalAnswerBodyProps) {
  const isDenyVariant = summary.type === "deny" || summary.type === "external";
  const shift = readShiftPayload(summary.payload);

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm text-muted-foreground">
        {summary.request ? <p className="font-medium text-foreground">{he.proposalScreen.yourRequest}</p> : null}
        <ProposalSummaryView
          type={summary.type}
          destination={summary.request?.destination}
          purpose={summary.request?.rideType}
          departAt={summary.request?.departAt ?? null}
          returnAt={summary.request?.returnAt ?? null}
        />
      </div>

      {!isDenyVariant ? (
        <div>
          <div className="flex gap-2">
            <BeforeAfterBox
              label={he.proposalScreen.before}
              depart={summary.request?.departAt ?? null}
              ret={summary.request?.returnAt ?? null}
            />
            <BeforeAfterBox
              label={summary.type === "merge" ? he.rideCoordination.combinedWindow : he.proposalScreen.after}
              depart={(summary.type === "merge" ? shift.starts_at : shift.depart_at) ?? summary.request?.departAt ?? null}
              ret={(summary.type === "merge" ? shift.ends_at : shift.return_at) ?? summary.request?.returnAt ?? null}
            />
          </div>
          {summary.type === "merge" ? <p className="mt-2 text-sm text-muted-foreground">{he.rideCoordination.combinedConsent}</p> : null}
        </div>
      ) : null}

      <div className="space-y-1 text-sm">
        <p className="font-medium">{he.proposalScreen.reason}</p>
        <p className="text-muted-foreground">{summary.reasonHe}</p>
      </div>

      {summary.expiresAt ? (
        <p className="text-xs text-muted-foreground" dir="ltr">
          {tv("proposalScreen.validUntil", { time: formatTime(new Date(summary.expiresAt)) })}
        </p>
      ) : null}

      {isDenyVariant ? (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={optOutFreed}
              onChange={(e) => onOptOutFreedChange(e.target.checked)}
            />
            {he.proposalScreen.optOutFreedSlots}
          </label>
          <div className="flex flex-col gap-2">
            <Button variant="outline" onClick={onDecline} disabled={isSubmitting}>
              {t("action.understood")}
            </Button>
            <Button onClick={onAccept} disabled={isSubmitting}>
              {summary.type === "external" ? t("action.acceptProposal") : t("action.foundExternal")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button size="lg" onClick={onAccept} disabled={isSubmitting}>
            {t("action.acceptProposal")}
          </Button>
          <Button variant="outline" onClick={onDecline} disabled={isSubmitting}>
            {t("action.declineProposal")}
          </Button>
        </div>
      )}

      {/*
       * "Talk to the sadran on WhatsApp" — the only escape hatch besides
       * accept/decline (owner decision). Hidden whenever `sadranPhone` is
       * missing: no session, `sadran_contact_of` returned no rows (an
       * unassigned week), or — today, always — the query never had a
       * `department_id`/`week_start` to call it with (see the doc comment
       * on `useSadranContactQuery`, `src/features/proposals/hooks.ts`).
       */}
      {sadranPhone ? (
        <Button asChild variant="outline" className="w-full">
          <a href={buildWaUrl(sadranPhone, he.proposalScreen.contactSadranWhatsappMessage)}>
            {he.proposalScreen.contactSadranWhatsapp}
          </a>
        </Button>
      ) : null}
    </div>
  );
}
