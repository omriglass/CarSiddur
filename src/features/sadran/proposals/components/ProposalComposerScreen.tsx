import { getDay } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

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
import { useProfile } from "@/features/auth/useProfile";
import { fetchBoardRideById } from "@/features/siddur/api";
import { he, t, tv } from "@/i18n/he";
import { env } from "@/lib/env";
import { TZ, formatTime } from "@/lib/time";
import { useQuery } from "@tanstack/react-query";

import { buildWaUrl, renderTemplate } from "../waLink";
import {
  useApplyProposalMutation,
  useCreateProposalMutation,
  useProfilesByIds,
  useProposalParties,
  useProposalsForWeek,
  useRecordAnswerOnBehalfMutation,
  useSendProposalMutation,
  useWeekRequests,
  useWhatsappTemplates,
} from "../../hooks";

import type { Json } from "@/integrations/supabase/types";
import type { Database } from "@/integrations/supabase/types";

type ProposalType = Database["public"]["Enums"]["proposal_type"];

interface ComposerPrefill {
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

  const profileQuery = useProfile();
  const requestsQuery = useWeekRequests(departmentId, weekStart);
  const templatesQuery = useWhatsappTemplates();

  const [requestId] = useState(prefill?.requestId ?? "");
  const [type] = useState<ProposalType>(prefill?.type ?? "shift");
  const [rideId] = useState<string | null>(prefill?.rideId ?? null);

  const request = (requestsQuery.data ?? []).find((r) => r.id === requestId);

  const hostRideQuery = useQuery({
    queryKey: ["sadran", "proposalHostRide", rideId],
    queryFn: () => fetchBoardRideById(rideId as string),
    enabled: !!rideId && type === "merge",
  });

  const extraPartyIds =
    type === "merge" && hostRideQuery.data?.driver_id && hostRideQuery.data.driver_id !== request?.requester_id
      ? [hostRideQuery.data.driver_id]
      : [];

  const contactIds = [request?.requester_id, ...extraPartyIds].filter((id): id is string => !!id);
  const contactsQuery = useProfilesByIds(contactIds);

  const [proposalId, setProposalId] = useState<string | null>(prefill?.proposalId ?? null);
  const [tokensByProfileId, setTokensByProfileId] = useState<Record<string, string>>({});
  const [editedText, setEditedText] = useState<string | null>(null);
  const [reasonInput, setReasonInput] = useState(
    typeof prefill?.payload.reason === "string" ? prefill.payload.reason : "",
  );
  const [externalHint, setExternalHint] = useState(
    typeof prefill?.payload.hint === "string" ? prefill.payload.hint : "cab",
  );

  const createMutation = useCreateProposalMutation();
  const sendMutation = useSendProposalMutation();
  const recordAnswerMutation = useRecordAnswerOnBehalfMutation();
  const applyMutation = useApplyProposalMutation();
  const partiesQuery = useProposalParties(proposalId ?? undefined);
  // Stage 3 hardening fix (bug found while writing e2e/proposal.spec.ts, UX_FLOWS.md §16 item
  // 9): `useApplyProposalMutation`/`he.sadranProposal.applyNow`/`.autoAppliedNote` already
  // existed but no screen ever rendered them — once every party accepts, a department with
  // `auto_apply_accepted_proposals = false` (REQ §7.3/§13; department_settings, admin-editable)
  // had no way to actually apply an accepted proposal to the board at all. Refetching the
  // week's proposals here (not just this one's parties) is the cheapest way to see this
  // proposal's own `status` (`sent` → `accepted` → `applied`) update after an answer.
  const proposalsForWeekQuery = useProposalsForWeek(departmentId, weekStart);
  const currentProposal = proposalsForWeekQuery.data?.find((p) => p.id === proposalId);

  const variant = VARIANT_OF_TYPE[type];
  const template = variant ? (templatesQuery.data ?? []).find((t) => t.variant === variant) : undefined;

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
      destination: request?.destination_text ?? "",
      day,
      date,
      depart: request?.depart_at ? formatTime(new Date(request.depart_at)) : "",
      return: request?.return_at ? formatTime(new Date(request.return_at)) : "",
      newDepart: typeof prefill?.payload.depart_at === "string" ? formatTime(new Date(prefill.payload.depart_at)) : "",
      newReturn: typeof prefill?.payload.return_at === "string" ? formatTime(new Date(prefill.payload.return_at)) : "",
      car: hostRideQuery.data?.car_id ?? "",
      driverName: hostRideQuery.data?.driver_name ?? "",
      passengerName: firstNameOf(requester?.full_name),
      detourMin: "",
      reason: typeof prefill?.payload.reason === "string" ? prefill.payload.reason : "",
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

  const previewText = editedText ?? (template ? renderTemplate(template.body, baseVars()) : "");

  /**
   * `proposals_payload_shape_ck` (supabase/migrations/20260907090900_proposals.sql
   * `validate_proposal_payload`) requires type-specific keys — an empty `{}`
   * payload is rejected outright. `null` means "not ready to submit yet"
   * (missing a required field the Sadran must still fill in).
   */
  function buildPayload(): Record<string, unknown> | null {
    if (type === "shift") {
      const departAt = (prefill?.payload.depart_at as string | undefined) ?? request?.depart_at ?? undefined;
      const returnAt = (prefill?.payload.return_at as string | undefined) ?? request?.return_at ?? undefined;
      if (!departAt && !returnAt) return null;
      return { ...prefill?.payload, depart_at: departAt, return_at: returnAt };
    }
    if (type === "deny") {
      if (!reasonInput.trim()) return null;
      return { ...prefill?.payload, reason: reasonInput };
    }
    if (type === "external") {
      if (!reasonInput.trim()) return null;
      return { ...prefill?.payload, hint: externalHint, reason: reasonInput };
    }
    if (type === "merge") {
      if (!rideId) return null;
      const legs = Array.isArray(prefill?.payload.legs)
        ? prefill.payload.legs
        : [{ ride_id: rideId, role: "passenger", leg: "both", car_mode: "passenger" }];
      return { ride_id: rideId, legs };
    }
    return null;
  }

  const payload = buildPayload();

  async function handleCreateAndSend() {
    if (!request || !payload) return;
    try {
      const newProposalId = await createMutation.mutateAsync({
        requestId: request.id,
        rideId,
        type,
        payload: payload as unknown as Json,
        reasonHe: previewText,
        partyProfileIds: extraPartyIds,
      });
      const sendResult = await sendMutation.mutateAsync({ proposalId: newProposalId, departmentId, weekStart });
      setProposalId(newProposalId);
      setTokensByProfileId(sendResult.party_tokens);
    } catch {
      // toasts already shown by the mutations
    }
  }

  function waButtonFor(contact: { id: string; full_name: string; phone: string | null }) {
    const token = tokensByProfileId[contact.id];
    if (!token || !contact.phone) return null;
    const link = `${env.VITE_APP_URL}/p/${token}`;
    const text = renderTemplate(previewText, { link });
    const url = buildWaUrl(contact.phone, text);
    return (
      <Button asChild key={contact.id} variant="outline" className="w-full">
        <a href={url} target="_blank" rel="noreferrer">
          {tv("sadranProposal.sendWhatsapp", { name: contact.full_name })}
        </a>
      </Button>
    );
  }

  if (!request) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <PageHeader title={he.screen.proposal.compose} />
        <p className="text-sm text-muted-foreground">{he.sadranProposal.listNone}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
      <PageHeader title={he.screen.proposal.compose} />

      <Card>
        <CardContent className="space-y-3 p-4 text-sm">
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

          <p className="text-muted-foreground">
            {request.destination_text} · {request.depart_at ? formatTime(new Date(request.depart_at)) : ""}
          </p>

          {(type === "deny" || type === "external") && !proposalId ? (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{he.sadranProposal.reasonLabel}</label>
              <Textarea value={reasonInput} onChange={(e) => setReasonInput(e.target.value)} rows={2} />
            </div>
          ) : null}

          {type === "external" && !proposalId ? (
            <Select value={externalHint} onValueChange={setExternalHint}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cab">{he.sadranProposal.hintCab}</SelectItem>
                <SelectItem value="rental">{he.sadranProposal.hintRental}</SelectItem>
                <SelectItem value="public_transport">{he.sadranProposal.hintPublicTransport}</SelectItem>
                <SelectItem value="private">{he.sadranProposal.hintPrivate}</SelectItem>
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

          {!proposalId ? (
            <Button
              className="w-full"
              onClick={handleCreateAndSend}
              disabled={!variant || !payload || createMutation.isPending || sendMutation.isPending}
            >
              {t("action.propose")}
            </Button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{he.sadranProposal.pushNote}</p>
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
                    {p.response === "pending" ? (
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
                onClick={() => navigate(`/sadran/${departmentId}/${weekStart}/proposals`)}
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
