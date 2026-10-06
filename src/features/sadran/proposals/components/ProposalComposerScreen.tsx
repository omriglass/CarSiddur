import { useState } from "react";
import { X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { paths } from "@/app/routes";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TimeField15 } from "@/components/TimeField15";
import { useCars, useDestinations } from "@/features/fleet/hooks";
import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useProfile } from "@/features/auth/useProfile";
import { ProposalSummary } from "@/features/proposals/components/ProposalSummary";
import { fetchBoardRideById } from "@/features/siddur/api";
import { he, t } from "@/i18n/he";
import { fetchProposalPartyTexts } from "../../api";
import { sadranKeys } from "../../keys";
import { servedOf } from "../../solverRun";
import { env } from "@/lib/env";
import { formatDayDate } from "@/lib/dayLabels";
import { routeLabel } from "@/lib/routeLabel";
import { formatTime } from "@/lib/time";
import { DEFAULT_STOP_MINUTES, homeTravelEdges, makeHop } from "@/lib/rideRoute";
import { mergePayloadLeg, previewMerge } from "../../board/mergeProposal";
import { useQuery } from "@tanstack/react-query";

import { renderTemplate } from "../waLink";
import { atTime, buildProposalPayload, resolveShiftTimes, seriesSpanOf } from "../buildProposalPayload";
import { seriesOriginalOf } from "../../board/draftInput";
import { combinedSummaryText, proposalTemplateVariant, externalSuggestionFor, proposalPreviewText } from "../proposalText";
import { WhatsappDialog } from "./WhatsappDialog";
import {
  useApplyProposalMutation,
  useCreateProposalMutation,
  useDepartmentSettings,
  usePlaceTravelForWeek,
  useProfilesByIds,
  useProposalParties,
  useProposalsForWeek,
  useRecordAnswerOnBehalfMutation,
  useSendProposalMutation,
  useSeriesLegsQuery,
  useWeekRequestsWithNames,
  useWhatsappTemplates,
} from "../../hooks";

import type { Json } from "@/integrations/supabase/types";
import type { ProposalType } from "@/lib/enums";

// Keep freshly issued links available when the coordinator revisits a sent proposal.
// Actor-scoped memory only: never localStorage or an unscoped cross-account lookup.
const sentTokensByActorAndProposal = new Map<string, Record<string, string>>();

interface ComposerPrefill {
  returnTo?: string;
  requestId: string;
  rideId: string | null;
  type: ProposalType;
  payload: Record<string, unknown>;
  /**
   * Set only when navigated here from an existing proposal's card in
   * `ProposalsListScreen.tsx` (not from the manual "compose new" dropdown). Stage 3
   * hardening bug fix (found while writing e2e/proposal.spec.ts, UX_FLOWS.md §16 item 9):
   * without this, revisiting an already-`sent`/`accepted`/`applied` proposal showed the
   * empty "compose a new one" form instead of its actual status, since `proposalId` was
   * otherwise only ever set locally right after this same screen sent one.
   */
  proposalId?: string;
}

interface ProposalComposerScreenProps {
  departmentId: string;
  weekStart: string;
}

/** `/sadran/:dept/:week/proposals/new` — proposal composer (UX_FLOWS.md §4.3). */
export function ProposalComposerScreen({ departmentId, weekStart }: ProposalComposerScreenProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = location.state as ComposerPrefill | null;
  const candidateReturn = typeof prefill?.returnTo === "string" ? prefill.returnTo : undefined;
  const candidatePath = candidateReturn?.split(/[?#]/)[0];
  const safeReturnPaths = new Set([
    paths.sadran.board(departmentId, weekStart),
    paths.sadran.proposals(departmentId, weekStart),
    paths.sadran.week(departmentId, weekStart),
  ]);
  const returnTo = candidateReturn && candidatePath && safeReturnPaths.has(candidatePath)
    ? candidateReturn : paths.sadran.board(departmentId, weekStart);

  const profileQuery = useProfile();
  const requestsQuery = useWeekRequestsWithNames(departmentId, weekStart);
  const templatesQuery = useWhatsappTemplates();
  const destinationsQuery = useDestinations(departmentId);
  const carsQuery = useCars(departmentId);

  // R2U1: "try again" wording only after a send actually failed; an opened draft's send is a plain action.
  const [sendFailed, setSendFailed] = useState(false);
  const [requestId] = useState(prefill?.requestId ?? "");
  const [selectedType] = useState<ProposalType>(prefill?.type ?? "shift");
  const [rideId] = useState<string | null>(prefill?.rideId ?? null);
  const [externalHint, setExternalHint] = useState(
    typeof prefill?.payload.hint === "string" ? prefill.payload.hint : "cab",
  );
  const type: ProposalType = selectedType === "external" && externalHint === "waive" ? "deny" : selectedType;

  const request = (requestsQuery.data ?? []).find((r) => r.id === requestId);
  const [departOverride, setDepartOverride] = useState<string | null>(null);
  const [returnOverride, setReturnOverride] = useState<string | null>(null);
  const { departAt, returnAt } = resolveShiftTimes(prefill?.payload, request);
  const proposedDepartAt = atTime(departAt, departOverride);
  const proposedReturnAt = atTime(returnAt, returnOverride);
  const destinationName = destinationsQuery.data?.find((d) => d.id === request?.destination_id)?.name ?? request?.destination_text ?? "";
  // REQ §13.93: every WhatsApp `proposal_received` template is rendered here (not in SQL) and
  // reads "{{route}}" — "ל<dest>", or "מ<origin> ל<dest>" when the origin is not home.
  const homeDestinationId = useActiveDepartment().departments.find((d) => d.id === departmentId)?.home_destination_id ?? null;
  const route = routeLabel({
    destination: destinationName,
    origin: request?.origin_resolved_name ?? request?.origin_text ?? null,
    originIsHome: !request?.origin_id ? !request?.origin_text : request.origin_id === homeDestinationId,
  });
  const originAway = !!request?.origin_id && request.origin_id !== homeDestinationId;

  const hostRideQuery = useQuery({
    queryKey: sadranKeys.proposalHostRide(rideId),
    queryFn: () => fetchBoardRideById(rideId as string),
    enabled: !!rideId && type === "merge",
  });

  const hostRequestIds = new Set(hostRideQuery.data ? servedOf(hostRideQuery.data).map((s) => s.request_id) : []);
  const extraPartyIds = type === "merge" ? [...new Set([
    hostRideQuery.data?.driver_id,
    ...(requestsQuery.data ?? []).filter((r) => hostRequestIds.has(r.id)).map((r) => r.requester_id),
  ].filter((id): id is string => !!id && id !== request?.requester_id))] : [];

  const [proposalId, setProposalId] = useState<string | null>(prefill?.proposalId ?? null);
  const [editedText, setEditedText] = useState<string | null>(null);
  const [reasonInput, setReasonInput] = useState(
    typeof prefill?.payload.reason === "string" ? prefill.payload.reason : "",
  );


  const createMutation = useCreateProposalMutation();
  const sendMutation = useSendProposalMutation();
  const recordAnswerMutation = useRecordAnswerOnBehalfMutation();
  const applyMutation = useApplyProposalMutation();
  const partiesQuery = useProposalParties(proposalId ?? undefined);
  const contactIds = [...new Set([request?.requester_id, ...extraPartyIds, ...(partiesQuery.data ?? []).map((p) => p.profile_id)].filter((id): id is string => !!id))];
  const contactsQuery = useProfilesByIds(contactIds);
  // Stage 3 hardening fix (bug found while writing e2e/proposal.spec.ts, UX_FLOWS.md §16 item
  // 9): `useApplyProposalMutation`/`he.sadranProposal.applyNow`/`.autoAppliedNote` already
  // existed but no screen ever rendered them — once every party accepts, a department with
  // `auto_apply_accepted_proposals = false` (REQ §7.3/§13; department_settings, admin-editable)
  // had no way to actually apply an accepted proposal to the board at all. Refetching the
  // week's proposals here (not just this one's parties) is the cheapest way to see this
  // proposal's own `status` (`sent` → `accepted` → `applied`) update after an answer.
  const proposalsForWeekQuery = useProposalsForWeek(departmentId, weekStart);
  const currentProposal = proposalsForWeekQuery.data?.find((p) => p.id === proposalId);
  const pendingProposal = proposalsForWeekQuery.data?.find((p) => p.request_id === requestId && p.status === "sent" && p.id !== proposalId);
  const pendingPartiesQuery = useProposalParties(pendingProposal?.id);
  const pendingHasAnswer = pendingPartiesQuery.data?.some((p) => p.response !== "pending") ?? false;
  const isDraft = !proposalId || currentProposal?.status === "draft";
  const busy = createMutation.isPending || sendMutation.isPending;
  const mergePayload = (currentProposal?.payload ?? prefill?.payload) as Record<string, unknown> | undefined;
  // REQ §13.94 (G10): the merged ride keeps the host's start and grows its end by the added
  // driving (`src/lib/rideRoute.ts`); the payload carries legs only, this window is display/text.
  const placeTravelQuery = usePlaceTravelForWeek(departmentId, weekStart, type === "merge");
  const settingsQuery = useDepartmentSettings(type === "merge" ? departmentId : undefined);
  const mergePreview = type === "merge" && hostRideQuery.data && request
    ? previewMerge(hostRideQuery.data, request, mergePayloadLeg(mergePayload, request), {
        hop: makeHop([...(placeTravelQuery.data ?? []), ...homeTravelEdges(homeDestinationId, destinationsQuery.data ?? [])]), stopMinutes: settingsQuery.data?.stop_minutes ?? DEFAULT_STOP_MINUTES, homeId: homeDestinationId,
      })
    : null;
  const combinedStart = typeof mergePayload?.starts_at === "string" ? mergePayload.starts_at : hostRideQuery.data?.starts_at;
  const combinedEnd = typeof mergePayload?.ends_at === "string" ? mergePayload.ends_at : (mergePreview?.endsAt ?? hostRideQuery.data?.ends_at);
  // `origin` (REQ §13.93, SOLVER §3.15): never editable in the composer — the board already
  // picked the free car/location pair, this screen only shows and sends it.
  const originPayload = type === "origin" ? ((currentProposal?.payload ?? prefill?.payload) as Record<string, unknown> | undefined) : undefined;
  const originIdValue = typeof originPayload?.origin_id === "string" ? originPayload.origin_id : undefined;
  const originCarIdValue = typeof originPayload?.car_id === "string" ? originPayload.car_id : undefined;
  const newOriginName = destinationsQuery.data?.find((d) => d.id === originIdValue)?.name ?? "";
  const originCarName = carsQuery.data?.find((c) => c.id === originCarIdValue)?.name ?? "";

  const variant = proposalTemplateVariant(type, (currentProposal?.payload ?? prefill?.payload) as Record<string, unknown> | undefined, {
    hostHasDriver: !!hostRideQuery.data?.driver_id, originAway,
    destinationIsHome: !!homeDestinationId && request?.destination_id === homeDestinationId,
    placed: request?.status === "assigned" || request?.status === "merged",
  });
  const template = variant ? (templatesQuery.data ?? []).find((t) => t.variant === variant) : undefined;
  const effectiveReason = reasonInput.trim() || he.sadranProposal.defaultReason;
  const externalSuggestion = externalSuggestionFor(type, externalHint);

  // REQ §13.101 j: a fewer-days shift states the series' original first/last day ("במקום").
  const isSeriesSpan = type === "shift" && !!seriesSpanOf((currentProposal?.payload ?? prefill?.payload) as Record<string, unknown> | undefined);
  const seriesLegsQuery = useSeriesLegsQuery(request?.series_id, isSeriesSpan);
  const textInput = {
    template,
    type,
    request,
    seriesOriginal: isSeriesSpan ? seriesOriginalOf(seriesLegsQuery.data ?? []) : null,
    requesterName: contactsQuery.data?.find((c) => c.id === request?.requester_id)?.full_name,
    sadranName: profileQuery.data?.full_name ?? "",
    destinationName,
    route,
    proposedDepartAt,
    proposedReturnAt,
    carName: type === "origin" ? originCarName : (carsQuery.data?.find((c) => c.id === hostRideQuery.data?.car_id)?.name ?? ""),
    // `origin` (REQ §13.93): the request's current origin vs. the free car's origin the board
    // suggested instead - baked into `reason_he` at creation time.
    origin: request?.origin_resolved_name ?? "",
    newOrigin: newOriginName,
    driverName: hostRideQuery.data?.driver_name ?? "",
    reason: effectiveReason,
    externalSuggestion,
    combined: type === "merge" && combinedStart && combinedEnd ? {
      start: combinedStart, end: combinedEnd,
      passengerName: contactsQuery.data?.find((c) => c.id === request?.requester_id)?.full_name ?? "",
      hostCarName: carsQuery.data?.find((c) => c.id === hostRideQuery.data?.car_id)?.name ?? "",
    } : null,
  };
  const combinedSummary = combinedSummaryText(textInput);
  // REQ §13.101 b: a merge reaches the joiner, the host and the other passengers with one text each.
  const partyTextsQuery = useQuery({
    queryKey: [...sadranKeys.all, "proposalPartyTexts", proposalId ?? ""],
    queryFn: () => fetchProposalPartyTexts(proposalId as string),
    enabled: !!proposalId && type === "merge",
    staleTime: 10_000,
  });
  const partyTexts = type === "merge" ? partyTextsQuery.data : undefined;
  const previewText = currentProposal?.reason_he ?? editedText ?? proposalPreviewText(textInput);

  const payload = buildProposalPayload({
    type, prefillPayload: prefill?.payload, request, rideId, proposedDepartAt, proposedReturnAt,
    effectiveReason, externalHint, originAway,
  });

  async function handleCreateAndSend() {
    if (!request || (!proposalId && !payload) || busy) return;
    try {
      const draftId = proposalId ?? await createMutation.mutateAsync({
        requestId: request.id,
        rideId,
        type,
        payload: payload as unknown as Json,
        reasonHe: previewText,
        partyProfileIds: extraPartyIds,
        departmentId,
        weekStart,
      });
      // Keep the successful creation even if sending fails. Retrying must send
      // this draft, rather than create a second proposal for the same request.
      setProposalId(draftId);
      const sendResult = await sendMutation.mutateAsync({
        proposalId: draftId, departmentId, weekStart,
        replacement: pendingProposal ? { id: pendingProposal.id, version: pendingProposal.version } : undefined,
      });
      if (profileQuery.data?.id) {
        sentTokensByActorAndProposal.set(`${profileQuery.data.id}:${draftId}`, sendResult.party_tokens);
      }
      navigate(returnTo, { replace: true });
      toast.success(he.sadranProposal.sentMark, {
        duration: 12000,
        action: {
          label: he.sadranProposal.openSentProposal,
          onClick: () => navigate(location.pathname, { state: {
            requestId: request.id, rideId, type, payload, proposalId: draftId,
            returnTo,
          } }),
        },
      });
    } catch {
      // toasts already shown by the mutations
      setSendFailed(true);
    }
  }

  /** REQ §13.94: store the proposal unsent (a board draft) and go back to the board. */
  async function handleSaveDraft() {
    if (!request || proposalId || !payload || busy) return;
    try {
      await createMutation.mutateAsync({
        requestId: request.id,
        rideId,
        type,
        payload: payload as unknown as Json,
        reasonHe: previewText,
        partyProfileIds: extraPartyIds,
        departmentId,
        weekStart,
      });
      toast.success(he.boardDrafts.saved);
      navigate(returnTo, { replace: true });
    } catch {
      // toast already shown by the mutation
    }
  }

  function waButtonFor(contact: { id: string; full_name: string; phone: string | null }) {
    const token = profileQuery.data?.id && proposalId ? sentTokensByActorAndProposal.get(`${profileQuery.data.id}:${proposalId}`)?.[contact.id] : undefined;
    if (!token || !contact.phone) return null;
    const link = `${env.VITE_APP_URL}/p/${token}`;
    const text = renderTemplate(partyTexts?.[contact.id] ?? previewText, { link });
    return (
      <WhatsappDialog key={contact.id} name={contact.full_name} phone={contact.phone} message={text} />
    );
  }

  const header = <PageHeader title={he.screen.proposal.compose} actions={
    <Button type="button" variant="ghost" size="icon" className="size-9" aria-label={he.sadranProposal.close} title={he.sadranProposal.close}
      onClick={() => navigate(returnTo, { replace: true })}>
      <X className="size-4" aria-hidden="true" />
    </Button>
  } />;

  if (!request) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        {header}
        <p className="text-sm text-muted-foreground">{he.sadranProposal.listNone}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
      {header}

      <Card>
        <CardContent className="space-y-3 p-4 text-sm">
          {type === "merge" && combinedStart && combinedEnd ? <div className="space-y-1 rounded-md border border-primary/40 p-3">
            <h2 className="font-medium">{he.rideCoordination.combinedWindow}</h2>
            <p className="font-semibold"><span className="tabular-nums">{formatDayDate(combinedStart)}</span> <span dir="ltr" className="tabular-nums">{formatTime(new Date(combinedStart))}–{formatTime(new Date(combinedEnd))}</span></p>
            <p>{combinedSummary}</p>
            <p className="text-muted-foreground">{he.rideCoordination.combinedConsent}</p>
          </div> : null}
          <div className="flex items-center gap-2">
            <span className="font-medium">{he.field.rideType}:</span>
            <Select value={type} disabled>
              <SelectTrigger className="w-48">
                <SelectValue>{he.proposal.type[type as "shift" | "merge" | "deny" | "external" | "origin"]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shift">{he.proposal.type.shift}</SelectItem>
                <SelectItem value="merge">{he.proposal.type.merge}</SelectItem>
                <SelectItem value="deny">{he.proposal.type.deny}</SelectItem>
                <SelectItem value="external">{he.proposal.type.external}</SelectItem>
                <SelectItem value="origin">{he.proposal.type.origin}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ProposalSummary requesterName={request.requester_full_name} destination={destinationName}
            purpose={request.ride_type_name_he} departAt={request.depart_at} returnAt={request.return_at}
            hostDriverName={type === "merge" ? hostRideQuery.data?.driver_name : undefined}
            originChange={type === "origin" ? { from: request.origin_resolved_name, to: newOriginName || null, car: originCarName || null } : undefined} />

          {type === "shift" && !proposalId ? <div className="flex flex-wrap gap-4">
            {departAt ? <label className="space-y-1 text-xs"><span className="block">{he.field.depart}</span><TimeField15 min="00:00" value={departOverride ?? formatTime(new Date(departAt))} onChange={(time) => { setDepartOverride(time); setEditedText(null); }} aria-label={he.field.depart} /></label> : null}
            {returnAt ? <label className="space-y-1 text-xs"><span className="block">{he.field.return}</span><TimeField15 min="00:00" max="23:59" value={returnOverride ?? formatTime(new Date(returnAt))} onChange={(time) => { setReturnOverride(time); setEditedText(null); }} aria-label={he.field.return} /></label> : null}
          </div> : null}

          {(type === "deny" || type === "external") && !proposalId ? (
            <div>
              <label htmlFor="proposal-reason" className="mb-1 block text-xs text-muted-foreground">{he.sadranProposal.reasonLabel}</label>
              <Textarea id="proposal-reason" value={reasonInput} placeholder={he.sadranProposal.defaultReason} onChange={(e) => setReasonInput(e.target.value)} rows={2} />
            </div>
          ) : null}

          {selectedType === "external" && !proposalId ? (
            <Select value={externalHint} onValueChange={(value) => { setExternalHint(value); setEditedText(null); }}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cab">{he.sadranProposal.hintCab}</SelectItem>
                <SelectItem value="public_transport">{he.sadranProposal.hintPublicTransport}</SelectItem>
                <SelectItem value="private">{he.sadranProposal.hintPrivate}</SelectItem>
                <SelectItem value="waive">{he.sadranProposal.hintWaive}</SelectItem>
              </SelectContent>
            </Select>
          ) : null}

          {!variant ? (
            <p className="text-amber-600">{he.sadranProposal.templateMissing}</p>
          ) : (
            <>
              <label className="block text-xs text-muted-foreground">{he.sadranProposal.previewTitle}</label>
              <Textarea
                value={previewText.replaceAll("{{link}}", he.sadranProposal.linkPlaceholder)}
                onChange={(e) => setEditedText(e.target.value.replaceAll(he.sadranProposal.linkPlaceholder, "{{link}}"))}
                rows={6}
                dir="rtl"
                disabled={!!proposalId}
              />
            </>
          )}

          {isDraft && pendingProposal ? (
            <div className="space-y-2 rounded-md border border-amber-500/50 p-3 text-sm" role="status">
              <p>{he.sadranProposal.pendingProposalNote}</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{pendingProposal.reason_he}</p>
              {pendingHasAnswer ? <p>{he.sadranProposal.replacementAnswered}</p> : null}
              <Button variant="outline" disabled={busy} onClick={() => navigate(location.pathname, {
                state: {
                  returnTo, requestId: pendingProposal.request_id, rideId: pendingProposal.ride_id,
                  type: pendingProposal.type, payload: pendingProposal.payload, proposalId: pendingProposal.id,
                },
              })}>{he.sadranProposal.viewPendingProposal}</Button>
            </div>
          ) : null}

          {isDraft ? (
            <>
            {proposalId && sendFailed ? <p className="text-sm text-muted-foreground">{he.sadranProposal.draftNote}</p> : null}
            <Button
              className="w-full"
              data-testid="composer-send"
              onClick={handleCreateAndSend}
              disabled={(!proposalId && (!variant || !payload || (type === "merge" && !hostRideQuery.data))) || busy || !proposalsForWeekQuery.isSuccess || proposalsForWeekQuery.isFetching || (!!pendingProposal && (!pendingPartiesQuery.isSuccess || pendingHasAnswer))}
            >
              {pendingProposal ? he.sadranProposal.replaceAndSend : proposalId ? (sendFailed ? he.sadranProposal.retrySend : he.boardDrafts.send) : t("action.propose")}
            </Button>
            {!proposalId ? (
              <Button
                className="w-full"
                variant="outline"
                data-testid="composer-save-draft"
                onClick={handleSaveDraft}
                disabled={!variant || !payload || (type === "merge" && !hostRideQuery.data) || busy}
              >
                {he.boardDrafts.saveDraft}
              </Button>
            ) : null}
            </>
          ) : (
            <div className="space-y-2">
              {currentProposal && currentProposal.status !== "draft" ? <p className="text-xs text-muted-foreground">{he.sadranProposal.pushNote}</p> : null}
              {(contactsQuery.data ?? []).map((c) => waButtonFor(c))}

              {currentProposal ? (
                <p className="flex items-center justify-between text-sm">
                  <span className="font-medium">{he.sadranProposal.proposalStatusLabel}</span>
                  <span>{he.proposalStatus[currentProposal.status]}</span>
                </p>
              ) : null}

              <div className="space-y-1 pt-2">
                <p className="font-medium">{he.sadranProposal.statusLabel}</p>
                {(partiesQuery.data ?? []).map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-xs">
                    <span>{contactsQuery.data?.find((c) => c.id === p.profile_id)?.full_name ?? p.profile_id}</span>
                    <span>{p.response === "pending" ? he.proposalStatus.sent : he.proposalStatus[p.response]}</span>
                    {p.response === "pending" && currentProposal?.status === "sent" ? (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            recordAnswerMutation.mutate({
                              proposalId,
                              profileId: p.profile_id,
                              accept: true,
                              departmentId,
                              weekStart,
                            })
                          }
                        >
                          {he.sadranProposal.manualAnswerAccept}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            recordAnswerMutation.mutate({
                              proposalId,
                              profileId: p.profile_id,
                              accept: false,
                              departmentId,
                              weekStart,
                            })
                          }
                        >
                          {he.sadranProposal.manualAnswerDecline}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              {currentProposal?.status === "accepted" ? (
                <Button
                  className="w-full"
                  disabled={applyMutation.isPending}
                  onClick={() =>
                    applyMutation.mutate(
                      { proposalId, departmentId, weekStart },
                      { onSuccess: () => toast.success(he.sadranDashboard.applied) },
                    )
                  }
                >
                  {he.sadranProposal.applyNow}
                </Button>
              ) : null}
              {currentProposal?.status === "applied" ? (
                <p className="text-xs text-muted-foreground">{he.sadranProposal.autoAppliedNote}</p>
              ) : null}

              <Button
                variant="outline"
                className="w-full"
                onClick={() => navigate(returnTo, { replace: true })}
              >
                {t("common.back")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
