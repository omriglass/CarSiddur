import { getDay } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { useState } from "react";
import { X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { PageHeader } from "@/components/PageHeader";
import { TripSummary } from "@/components/TripSummary";
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
import { useProfile } from "@/features/auth/useProfile";
import { fetchBoardRideById } from "@/features/siddur/api";
import { he, t, tv } from "@/i18n/he";
import { servedOf } from "../../solverRun";
import { env } from "@/lib/env";
import { TZ, formatTime } from "@/lib/time";
import { useQuery } from "@tanstack/react-query";

import { renderTemplate } from "../waLink";
import { WhatsappDialog } from "./WhatsappDialog";
import {
  useApplyProposalMutation,
  useCreateProposalMutation,
  useProfilesByIds,
  useProposalParties,
  useProposalsForWeek,
  useRecordAnswerOnBehalfMutation,
  useSendProposalMutation,
  useWeekRequestsWithNames,
  useWhatsappTemplates,
} from "../../hooks";

import type { Json } from "@/integrations/supabase/types";
import type { Database } from "@/integrations/supabase/types";

type ProposalType = Database["public"]["Enums"]["proposal_type"];

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

const VARIANT_OF_TYPE: Record<ProposalType, string | null> = {
  shift: "shift",
  merge: "merge_passenger",
  deny: "deny",
  // Stage 3 hardening fix #4 (DATA_MODEL.md §6.1 item 19): `external`'s WhatsApp copy
  // (UX_FLOWS.md §6.2 `wa.external`) is now seeded (`supabase/seed.sql`), so the composer
  // can look it up like every other type. `chauffeur` still has no dedicated proposal-type
  // value (SOLVER.md §3.15: it is sent as a `merge` proposal with `role: 'driver'`) and no
  // composer action yet — UX_FLOWS.md §15 item 6 records that as a separate, still-open gap.
  external: "external",
};

/** `/sadran/:dept/:week/proposals/new` — proposal composer (UX_FLOWS.md §4.3). */
export function ProposalComposerScreen({ departmentId, weekStart }: ProposalComposerScreenProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = location.state as ComposerPrefill | null;
  const weekBase = `/sadran/${departmentId}/${weekStart}`;
  const candidateReturn = typeof prefill?.returnTo === "string" ? prefill.returnTo : undefined;
  const candidatePath = candidateReturn?.split(/[?#]/)[0];
  const returnTo = candidateReturn && (candidatePath === `${weekBase}/board` || candidatePath === `${weekBase}/proposals` || candidatePath === weekBase)
    ? candidateReturn : `${weekBase}/board`;

  const profileQuery = useProfile();
  const requestsQuery = useWeekRequestsWithNames(departmentId, weekStart);
  const templatesQuery = useWhatsappTemplates();
  const destinationsQuery = useDestinations(departmentId);
  const carsQuery = useCars(departmentId);

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
  const departAt = typeof prefill?.payload.depart_at === "string" ? prefill.payload.depart_at : request?.depart_at;
  const requestedReturnAt = typeof prefill?.payload.return_at === "string" ? prefill.payload.return_at : request?.return_at;
  const returnAt = departAt && requestedReturnAt && formatInTimeZone(departAt, TZ, "yyyy-MM-dd") !== formatInTimeZone(requestedReturnAt, TZ, "yyyy-MM-dd")
    ? fromZonedTime(`${formatInTimeZone(departAt, TZ, "yyyy-MM-dd")}T23:59:00`, TZ).toISOString()
    : requestedReturnAt;
  function atTime(instant: string | null | undefined, time: string | null) {
    return instant && time ? fromZonedTime(`${formatInTimeZone(instant, TZ, "yyyy-MM-dd")}T${time}:00`, TZ).toISOString() : instant;
  }
  const proposedDepartAt = atTime(departAt, departOverride);
  const proposedReturnAt = atTime(returnAt, returnOverride);
  const destinationName = destinationsQuery.data?.find((d) => d.id === request?.destination_id)?.name ?? request?.destination_text ?? "";

  const hostRideQuery = useQuery({
    queryKey: ["sadran", "proposalHostRide", rideId],
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
  const combinedStart = typeof mergePayload?.starts_at === "string" ? mergePayload.starts_at : hostRideQuery.data?.starts_at;
  const combinedEnd = typeof mergePayload?.ends_at === "string" ? mergePayload.ends_at : hostRideQuery.data?.ends_at;

  const variant = VARIANT_OF_TYPE[type];
  const template = variant ? (templatesQuery.data ?? []).find((t) => t.variant === variant) : undefined;
  const effectiveReason = reasonInput.trim() || he.sadranProposal.defaultReason;
  const externalSuggestion = type === "external"
    ? he.sadranProposal.externalSuggestion[externalHint as keyof typeof he.sadranProposal.externalSuggestion] ?? he.sadranProposal.externalSuggestion.private
    : "";

  function firstNameOf(fullName: string | undefined): string {
    return fullName?.split(" ")[0] ?? "";
  }

  function baseVars(): Record<string, string> {
    const requesterId = request?.requester_id;
    const requester = contactsQuery.data?.find((c) => c.id === requesterId);
    // Stage 3 hardening bug fix (found while writing e2e/proposal.spec.ts): date-fns'
    // "EEEE" token has no locale here, so this previously rendered the *English* weekday
    // name ("Friday") into an otherwise all-Hebrew WhatsApp message. `he.days.long` (already
    // used everywhere else a Hebrew weekday name is needed) indexed by the Asia/Jerusalem
    // zoned day-of-week (hard rule 6 — never a raw, unzoned `getDay()`) is correct.
    const day = request?.depart_at ? (he.days.long[getDay(toZonedTime(new Date(request.depart_at), TZ))] ?? "") : "";
    const date = request?.depart_at ? formatInTimeZone(new Date(request.depart_at), TZ, "d.M") : "";
    return {
      firstName: firstNameOf(requester?.full_name),
      sadranName: profileQuery.data?.full_name ?? "",
      destination: destinationName,
      day,
      date,
      depart: request?.depart_at ? formatTime(new Date(request.depart_at)) : "",
      return: request?.return_at ? formatTime(new Date(request.return_at)) : "",
      newDepart: proposedDepartAt ? formatTime(new Date(proposedDepartAt)) : "",
      newReturn: proposedReturnAt ? formatTime(new Date(proposedReturnAt)) : "",
      car: carsQuery.data?.find((c) => c.id === hostRideQuery.data?.car_id)?.name ?? "",
      driverName: hostRideQuery.data?.driver_name ?? "",
      passengerName: firstNameOf(requester?.full_name),
      detourMin: "",
      reason: effectiveReason,
      externalSuggestion,
      expiresAt: "",
      // Deliberately no `link` key (Stage 3 hardening bug fix, found while writing
      // e2e/proposal.spec.ts, UX_FLOWS.md §16 item 9): `renderTemplate` only replaces a
      // `{{name}}` placeholder it has a var for, leaving anything else untouched — so
      // `{{link}}` survives into `previewText` below and stays substitutable. Filling it in
      // here with a placeholder string (the previous code did) would *replace* the literal
      // `{{link}}` token in `previewText` with that placeholder text; `waButtonFor`'s own
      // second `renderTemplate(previewText, { link })` pass then has no `{{link}}` token left
      // to find, so the real per-recipient link silently never made it into the actual
      // WhatsApp message text — every proposal ever sent linked to a dead placeholder string
      // instead of `/p/<token>`. The live preview textarea now shows the literal `{{link}}`
      // token before sending, which is the correct tradeoff (a real link doesn't exist yet).
    };
  }

  const combinedSummary = type === "merge" && combinedStart && combinedEnd ? tv("rideCoordination.combinedSummary", {
    driver: hostRideQuery.data?.driver_name ?? "",
    passenger: contactsQuery.data?.find((c) => c.id === request?.requester_id)?.full_name ?? "",
    destination: destinationName,
    car: carsQuery.data?.find((c) => c.id === hostRideQuery.data?.car_id)?.name ?? "",
    start: formatTime(new Date(combinedStart)), end: formatTime(new Date(combinedEnd)),
  }) : "";
  const previewText = currentProposal?.reason_he ?? editedText ?? (template ? [
    combinedSummary,
    renderTemplate(template.body, baseVars()),
    // Older/custom templates may not have these placeholders. Include the
    // selected alternative and optional explanation in the member's message.
    (type === "deny" || type === "external") && !template.body.includes("{{reason}}") ? effectiveReason : "",
    !template.body.includes("{{externalSuggestion}}") ? externalSuggestion : "",
  ].filter(Boolean).join("\n\n") : "");

  /**
   * `proposals_payload_shape_ck` (supabase/migrations/20260907090900_proposals.sql
   * `validate_proposal_payload`) requires type-specific keys — an empty `{}`
   * payload is rejected outright. `null` means "not ready to submit yet"
   * (missing a required field the Sadran must still fill in).
   */
  function buildPayload(): Record<string, unknown> | null {
    if (type === "shift") {
      const departAt = proposedDepartAt;
      const returnAt = proposedReturnAt;
      if (!departAt && !returnAt) return null;
      if (departAt && returnAt && (Date.parse(returnAt) <= Date.parse(departAt) || formatInTimeZone(departAt, TZ, "yyyy-MM-dd") !== formatInTimeZone(returnAt, TZ, "yyyy-MM-dd"))) return null;
      return { ...prefill?.payload, depart_at: departAt, return_at: returnAt };
    }
    if (type === "deny") {
      return { ...prefill?.payload, reason: effectiveReason };
    }
    if (type === "external") {
      return { ...prefill?.payload, hint: externalHint, reason: effectiveReason };
    }
    if (type === "merge") {
      if (!rideId) return null;
      const legs = Array.isArray(prefill?.payload.legs)
        ? prefill.payload.legs
        : [{ ride_id: rideId, role: "passenger", leg: request?.trip_shape === "one_way_to" ? "out" : request?.trip_shape === "one_way_from" ? "return" : "both", car_mode: "passenger" }];
      return { ...prefill?.payload, ride_id: rideId, legs, starts_at: combinedStart, ends_at: combinedEnd };
    }
    return null;
  }

  const payload = buildPayload();

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
    }
  }

  function waButtonFor(contact: { id: string; full_name: string; phone: string | null }) {
    const token = profileQuery.data?.id && proposalId ? sentTokensByActorAndProposal.get(`${profileQuery.data.id}:${proposalId}`)?.[contact.id] : undefined;
    if (!token || !contact.phone) return null;
    const link = `${env.VITE_APP_URL}/p/${token}`;
    const text = renderTemplate(previewText, { link });
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
            <p dir="ltr" className="font-semibold tabular-nums">{formatInTimeZone(combinedStart, TZ, "d/M/yy HH:mm")}–{formatTime(new Date(combinedEnd))}</p>
            <p>{combinedSummary}</p>
            <p className="text-muted-foreground">{he.rideCoordination.combinedConsent}</p>
          </div> : null}
          <div className="flex items-center gap-2">
            <span className="font-medium">{he.field.rideType}:</span>
            <Select value={type} disabled>
              <SelectTrigger className="w-48">
                <SelectValue>{he.proposal.type[type as "shift" | "merge" | "deny" | "external"]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shift">{he.proposal.type.shift}</SelectItem>
                <SelectItem value="merge">{he.proposal.type.merge}</SelectItem>
                <SelectItem value="deny">{he.proposal.type.deny}</SelectItem>
                <SelectItem value="external">{he.proposal.type.external}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <TripSummary name={request.requester_full_name} destination={destinationName}
            purpose={request.ride_type_name_he} departAt={request.depart_at} returnAt={request.return_at} />

          {type === "shift" && !proposalId ? <div className="flex flex-wrap gap-4">
            {departAt ? <label className="space-y-1 text-xs"><span className="block">{he.field.depart}</span><TimeField15 min="00:00" value={departOverride ?? formatInTimeZone(departAt, TZ, "HH:mm")} onChange={(time) => { setDepartOverride(time); setEditedText(null); }} aria-label={he.field.depart} /></label> : null}
            {returnAt ? <label className="space-y-1 text-xs"><span className="block">{he.field.return}</span><TimeField15 min="00:00" max="23:59" value={returnOverride ?? formatInTimeZone(returnAt, TZ, "HH:mm")} onChange={(time) => { setReturnOverride(time); setEditedText(null); }} aria-label={he.field.return} /></label> : null}
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
                value={previewText}
                onChange={(e) => setEditedText(e.target.value)}
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
            {proposalId ? <p className="text-sm text-muted-foreground">{he.sadranProposal.draftNote}</p> : null}
            <Button
              className="w-full"
              onClick={handleCreateAndSend}
              disabled={(!proposalId && (!variant || !payload || (type === "merge" && !hostRideQuery.data?.driver_id))) || busy || !proposalsForWeekQuery.isSuccess || proposalsForWeekQuery.isFetching || (!!pendingProposal && (!pendingPartiesQuery.isSuccess || pendingHasAnswer))}
            >
              {pendingProposal ? he.sadranProposal.replaceAndSend : proposalId ? he.sadranProposal.retrySend : t("action.propose")}
            </Button>
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
