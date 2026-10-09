import { externalHintFromSuggestion } from "@/features/sadran/proposals/externalHint";
import { useState } from "react";
import { X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { paths } from "@/app/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import { he, t, tv } from "@/i18n/he";
import { fetchProposalPartyTexts, type ProposalCarConflict } from "../../api";
import { sadranKeys } from "../../keys";
import { servedOf } from "../../solverRun";
import { env } from "@/lib/env";
import { formatDayDate } from "@/lib/dayLabels";
import { routeLabel } from "@/lib/routeLabel";
import { formatTime } from "@/lib/time";
import { DEFAULT_STOP_MINUTES, homeTravelEdges, makeHop, makeHopKm } from "@/lib/rideRoute";
import { applyServerMergeTimes, personOverlapWarning, mergeLegSummary, mergePayloadLeg, mergePayloadLegs, mergeVerdict, previewMerge } from "../../board/mergeProposal";
import { useQuery } from "@tanstack/react-query";

import { renderTemplate } from "../waLink";
import { atTime, buildProposalPayload, resolveShiftTimes, seriesSpanOf } from "../buildProposalPayload";
import { alternativeTextInput, seriesOriginalOf } from "../../board/draftInput";
import { alternativeLegWindows, carsFreeForWindow } from "../alternativeCars";
import { combinedSummaryText, proposalTemplateVariant, externalSuggestionFor, proposalPreviewText, shiftTimesUnchanged } from "../proposalText";
import { WhatsappDialog } from "./WhatsappDialog";
import {
  useAllWeekRides,
  useApplyProposalMutation,
  useCreateProposalMutation,
  useDepartmentSettings,
  useMergePreview,
  useMergePreviews,
  usePlaceTravelForWeek,
  useProfilesByIds,
  useProposalParties,
  useProposalsForWeek,
  useRecordAnswerOnBehalfMutation,
  useProposalCarConflictsMutation,
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

/** A car chooser for one plan-B leg (R11M1): the cars free for that leg's window, the chosen one always included. */
function AltCarSelect({ cars, value, onChange, disabled, testId }: {
  cars: readonly { id: string; name: string }[]; value: string | null; onChange: (carId: string) => void; disabled: boolean; testId: string;
}) {
  return (
    <Select value={value ?? ""} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-56" data-testid={testId}>
        <SelectValue placeholder={he.sadranProposal.altNoCar}>{cars.find((car) => car.id === value)?.name}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {cars.map((car) => <SelectItem key={car.id} value={car.id}>{car.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
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
    typeof prefill?.payload.hint === "string" ? externalHintFromSuggestion(prefill.payload.hint) : "cab",
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
  const conflictsMutation = useProposalCarConflictsMutation();
  // R10B6/R10F1: the car(s) another pending proposal holds; the Sadran may send anyway.
  const [carConflicts, setCarConflicts] = useState<ProposalCarConflict[] | null>(null);
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
  const mergeEdges = [...(placeTravelQuery.data ?? []), ...homeTravelEdges(homeDestinationId, destinationsQuery.data ?? [])];
  const mergeLegValue = request ? mergePayloadLeg(mergePayload, request) : "out";
  // R5B5 / U2: the window and the joiner's own times are the server's `merge_preview`, the same numbers the popup and every message show.
  const serverMergeQuery = useMergePreview(hostRideQuery.data?.id, request?.id, mergeLegValue, type === "merge");
  const twinPreview = type === "merge" && hostRideQuery.data && request
    ? previewMerge(hostRideQuery.data, request, mergePayloadLeg(mergePayload, request), {
        // R4B5: the same context as the board (hop + km + detour limits) so both show the same times.
        hop: makeHop(mergeEdges), hopKm: makeHopKm(mergeEdges), stopMinutes: settingsQuery.data?.stop_minutes ?? DEFAULT_STOP_MINUTES, homeId: homeDestinationId,
        detourLimitMinutes: settingsQuery.data?.detour_limit_minutes, detourLimitKm: settingsQuery.data?.detour_limit_km,
      })
    : null;
  const mergePreview = request ? applyServerMergeTimes(twinPreview, serverMergeQuery.data, request) : twinPreview;
  // REQ item 108 (M1): whether this merge may be sent/drafted is the server's verdict (`merge_preview` ok/code) for every
  // leg the payload carries (a split merge has legs on two rides); the TS twin only fills in when the preview call failed.
  const payloadLegs = type === "merge" ? mergePayloadLegs(mergePayload) : [];
  const verdictSpecs = type === "merge" && request
    ? (payloadLegs.length ? payloadLegs.map((entry) => ({ rideId: entry.ride_id, requestId: request.id, leg: entry.leg })) : [{ rideId: hostRideQuery.data?.id, requestId: request.id, leg: mergeLegValue }])
    : [];
  const verdictQueries = useMergePreviews(verdictSpecs, type === "merge" && isDraft);
  const mergeGate = type === "merge" && isDraft && request
    ? mergeVerdict(verdictQueries, twinPreview && !twinPreview.valid ? twinPreview.invalid : null)
    : null;
  const mergeBlocked = !!mergeGate && mergeGate.status !== "ok";
  const combinedStart = typeof mergePayload?.starts_at === "string" ? mergePayload.starts_at : (mergePreview?.startsAt ?? hostRideQuery.data?.starts_at);
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
    timesUnchanged: type === "shift" && !!request && shiftTimesUnchanged({ type, request, proposedDepartAt, proposedReturnAt }),
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
    // R3B6: the merged legs decide the wording (a return-only guest is collected from the destination).
    mergeLeg: type === "merge" && request ? mergeLegSummary(currentProposal?.payload ?? prefill?.payload, request) : undefined,
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
    // REQ §13.112 (a): the plan B the text speaks of (the request's own `request_alternatives` row).
    alternative: type === "alternative" ? alternativeTextInput(request) : undefined,
    combined: type === "merge" && combinedStart && combinedEnd ? {
      start: combinedStart, end: combinedEnd,
      passengerName: contactsQuery.data?.find((c) => c.id === request?.requester_id)?.full_name ?? "",
      hostCarName: carsQuery.data?.find((c) => c.id === hostRideQuery.data?.car_id)?.name ?? "",
      joinerOutAt: mergePreview?.joinerOutAt, joinerReturnAt: mergePreview?.joinerReturnAt,
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

  // R11M1 (REQ §13.112 a): the plan-B composer shows the solver's car(s) and times; the Sadran may change each car (no car, no proposal).
  const altSource = type === "alternative" ? ((currentProposal?.payload ?? prefill?.payload) as Record<string, unknown> | undefined) : undefined;
  const altStoredOut = typeof altSource?.car_id === "string" ? altSource.car_id : null;
  const altStoredPickup = typeof altSource?.return_car_id === "string" ? altSource.return_car_id : altStoredOut;
  const [altOutOverride, setAltOutOverride] = useState<string | null>(null);
  const [altPickupOverride, setAltPickupOverride] = useState<string | null>(null);
  const altOutCar = altOutOverride ?? altStoredOut;
  const altPickupCar = altPickupOverride ?? (altOutOverride && altStoredPickup === altStoredOut ? altOutOverride : altStoredPickup);
  const altRidesQuery = useAllWeekRides(type === "alternative" ? departmentId : undefined, weekStart);
  const altRow = type === "alternative" ? request?.alternative : null;
  const altDepartAt = typeof altSource?.depart_at === "string" ? altSource.depart_at : null;
  const altReturnAt = typeof altSource?.return_at === "string" ? altSource.return_at : null;
  const altWindows = altRow && altDepartAt
    ? alternativeLegWindows({ departAt: altDepartAt, arriveBy: altRow.arrive_by, pickupAt: altRow.pickup ? altRow.pickup_at : null, returnAt: altReturnAt })
    : null;

  const payload = buildProposalPayload({
    type, prefillPayload: type === "alternative" && !proposalId ? { ...prefill?.payload, car_id: altOutCar ?? undefined, return_car_id: altPickupCar ?? undefined } : prefill?.payload,
    request, rideId, proposedDepartAt, proposedReturnAt,
    effectiveReason, externalHint, originAway,
  });

  async function handleCreateAndSend(confirmedConflicts = false) {
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
      if (!confirmedConflicts) {
        const found = await conflictsMutation.mutateAsync(draftId);
        if (found.length) { setCarConflicts(found); return; }
      }
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
            <span className="font-medium">{he.sadranProposal.typeLabel}:</span>
            <Select value={type} disabled>
              <SelectTrigger className="w-48">
                <SelectValue>{he.proposal.type[type]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shift">{he.proposal.type.shift}</SelectItem>
                <SelectItem value="merge">{he.proposal.type.merge}</SelectItem>
                <SelectItem value="deny">{he.proposal.type.deny}</SelectItem>
                <SelectItem value="external">{he.proposal.type.external}</SelectItem>
                <SelectItem value="origin">{he.proposal.type.origin}</SelectItem>
                <SelectItem value="alternative">{he.proposal.type.alternative}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ProposalSummary requesterName={request.requester_full_name} destination={destinationName}
            purpose={request.ride_type_name_he} departAt={request.depart_at} returnAt={request.return_at}
            hostDriverName={type === "merge" ? hostRideQuery.data?.driver_name : undefined}
            originChange={type === "origin" ? { from: request.origin_resolved_name, to: newOriginName || null, car: originCarName || null } : undefined}
            alternative={type === "alternative" ? alternativeTextInput(request) : undefined} />

          {type === "alternative" && altRow && altDepartAt && altWindows ? (
            <div className="space-y-3 rounded-md border p-3" data-testid="composer-alt-cars">
              <h2 className="font-medium">{he.sadranProposal.altCarsTitle}</h2>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{he.sadranProposal.altOutCar}</p>
                <p data-testid="composer-alt-out-line">{tv("sadranProposal.altOutLine", {
                  depart: formatTime(new Date(altDepartAt)), arrive: formatTime(new Date(altRow.arrive_by)),
                  place: altRow.drop_place?.name ?? altRow.drop_place_text ?? "",
                })}</p>
                <AltCarSelect testId="composer-alt-out-car" value={altOutCar} disabled={!!proposalId}
                  cars={carsFreeForWindow(carsQuery.data ?? [], altRidesQuery.data ?? [], altWindows.out, altOutCar)}
                  onChange={(id) => { setAltOutOverride(id); setEditedText(null); }} />
              </div>
              {altRow.pickup && altRow.pickup_at && altWindows.pickup ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">{he.sadranProposal.altPickupCar}</p>
                  <p data-testid="composer-alt-pickup-line">
                    {tv(altRow.pickup_place || altRow.pickup_place_text ? "sadranProposal.altPickupFromLine" : "sadranProposal.altPickupLine", {
                      pickup: formatTime(new Date(altRow.pickup_at)), pickupPlace: altRow.pickup_place?.name ?? altRow.pickup_place_text ?? "",
                    })}
                    {altReturnAt ? ` · ${tv("sadranProposal.altBackLine", { back: formatTime(new Date(altReturnAt)) })}` : ""}
                  </p>
                  <AltCarSelect testId="composer-alt-pickup-car" value={altPickupCar} disabled={!!proposalId}
                    cars={carsFreeForWindow(carsQuery.data ?? [], altRidesQuery.data ?? [], altWindows.pickup, altPickupCar)}
                    onChange={(id) => { setAltPickupOverride(id); setEditedText(null); }} />
                  {altPickupCar && altOutCar && altPickupCar !== altOutCar ? <p className="text-xs font-medium text-amber-700" data-testid="composer-alt-other-car">{he.sadranProposal.altOtherCar}</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}

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
            <Select value={externalHint} onValueChange={(value) => { setExternalHint(externalHintFromSuggestion(value)); setEditedText(null); }}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cab">{he.sadranProposal.hintCab}</SelectItem>
                <SelectItem value="rental">{he.sadranProposal.hintRental}</SelectItem>
                <SelectItem value="public_transport">{he.sadranProposal.hintPublicTransport}</SelectItem>
                <SelectItem value="private">{he.sadranProposal.hintPrivate}</SelectItem>
                <SelectItem value="waive">{he.sadranProposal.hintWaive}</SelectItem>
              </SelectContent>
            </Select>
          ) : null}

          {type === "merge" && personOverlapWarning(serverMergeQuery.data) ? <p className="text-maintenance" role="status" data-testid="merge-person-overlap">{personOverlapWarning(serverMergeQuery.data)}</p> : null}
          {mergeGate?.status === "refused" ? (
            <p className="font-semibold text-destructive" role="alert" data-testid="composer-merge-invalid" data-code={mergeGate.code ?? undefined}>{mergeGate.message}</p>
          ) : mergeGate?.status === "loading" ? (
            <p className="text-muted-foreground" role="status" data-testid="composer-merge-checking">{he.mergedRide.checking}</p>
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
              onClick={() => handleCreateAndSend()}
              disabled={(!proposalId && (!variant || !payload || (type === "merge" && !hostRideQuery.data))) || mergeBlocked || busy || !proposalsForWeekQuery.isSuccess || proposalsForWeekQuery.isFetching || (!!pendingProposal && (!pendingPartiesQuery.isSuccess || pendingHasAnswer))}
            >
              {pendingProposal ? he.sadranProposal.replaceAndSend : proposalId ? (sendFailed ? he.sadranProposal.retrySend : he.boardDrafts.send) : t("action.propose")}
            </Button>
            {!proposalId ? (
              <Button
                className="w-full"
                variant="outline"
                data-testid="composer-save-draft"
                onClick={handleSaveDraft}
                disabled={!variant || !payload || (type === "merge" && !hostRideQuery.data) || mergeBlocked || busy}
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
      <ConfirmDialog
        open={!!carConflicts}
        onOpenChange={(open) => { if (!open) setCarConflicts(null); }}
        title={he.sadranProposal.carConflictTitle}
        confirmLabel={he.sadranProposal.carConflictSend}
        cancelLabel={he.sadranProposal.carConflictBack}
        loading={busy}
        onConfirm={() => { setCarConflicts(null); void handleCreateAndSend(true); }}
      >
        <ul className="space-y-1 text-sm" data-testid="car-conflicts">
          {(carConflicts ?? []).map((conflict, index) => (
            <li key={`${conflict.proposal_id}:${conflict.car_id}:${index}`}>
              {tv("sadranProposal.carConflictLine", {
                name: conflict.requester_name, car: conflict.car_name,
                from: formatTime(new Date(conflict.from_at)), to: formatTime(new Date(conflict.to_at)),
              })}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{he.sadranProposal.carConflictHelp}</p>
      </ConfirmDialog>
    </div>
  );
}
