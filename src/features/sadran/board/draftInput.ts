import { externalHintFromSuggestion } from "@/features/sadran/proposals/externalHint";
// REQ §13.94: "טיוטה" on the board creates the proposal the composer would have created - same
// payload (`buildProposalPayload`) and the same stored WhatsApp text (`proposalPreviewText`) -
// without leaving the board. Pure: the caller supplies the already-loaded rows.
import { he } from "@/i18n/he";
import { routeLabel } from "@/lib/routeLabel";
import type { ProposalType } from "@/lib/enums";

import { servedOf } from "../applySolve";
import { applyServerMergeTimes, mergeLegSummary, mergePayloadLeg, mergePayloadLegs, previewMerge, type MergeRouteContext, type ServerMergePreview } from "./mergeProposal";
import { buildProposalPayload, resolveShiftTimes, seriesSpanOf } from "../proposals/buildProposalPayload";
import { externalSuggestionFor, proposalPreviewText, proposalTemplateVariant, shiftTimesUnchanged } from "../proposals/proposalText";

import type { BoardRide, CreateProposalInput, NotificationTemplateRow, WeekRequestRow } from "../api";
import type { Json } from "@/integrations/supabase/types";

/** What every board popup hands to the composer today. */
export interface ComposerPrefill {
  requestId: string;
  rideId: string | null;
  type: ProposalType;
  payload: Record<string, unknown>;
  proposalId?: string;
  /** Board-only hints for the merge popup (never sent): the card's own leg, and how this merge relates to the request's open draft. */
  anchorLeg?: "out" | "return" | null;
  draftNote?: "extends" | "replaces" | null;
  /** The ride this drop merges into - the popup's leg toggle edits only its leg (a split merge keeps the other ride's leg). */
  legRideId?: string;
}

export interface DraftInputContext {
  requests: readonly WeekRequestRow[];
  rides: readonly BoardRide[];
  templates: readonly Pick<NotificationTemplateRow, "variant" | "body">[];
  destinations: readonly { id: string; name: string }[];
  cars: readonly { id: string; name: string }[];
  sadranName: string;
  homeDestinationId: string | null | undefined;
  /** Travel data for the merged-ride window in the message text (REQ §13.94). */
  route?: MergeRouteContext;
  /** R5B5: the server's `merge_preview` for the dropped-on ride - the text's window and the guest's own times come from it. */
  serverMerge?: ServerMergePreview | null;
}

export type DraftInputResult =
  | { ok: true; input: CreateProposalInput }
  | { ok: false };

/** The full span of a multi-day request's legs (first departure, last return), or null. */
export function seriesOriginalOf(legs: readonly { departAt: string | null; returnAt: string | null }[]): { departAt: string; returnAt: string } | null {
  const departs = legs.map((l) => l.departAt).filter((x): x is string => !!x).sort();
  const returns = legs.map((l) => l.returnAt).filter((x): x is string => !!x).sort();
  return departs.length && returns.length ? { departAt: departs[0]!, returnAt: returns[returns.length - 1]! } : null;
}

/** REQ §13.112 (a): the member's plan B as the proposal text speaks of it (the request's own `request_alternatives` row). */
export function alternativeTextInput(request: Pick<WeekRequestRow, "alternative"> | undefined): { dropPlace: string; arriveBy: string; pickupAt: string | null; pickupPlace?: string } | undefined {
  const alt = request?.alternative;
  if (!alt) return undefined;
  const pickupPlace = alt.pickup_place?.name ?? alt.pickup_place_text ?? "";
  return { dropPlace: alt.drop_place?.name ?? alt.drop_place_text ?? "", arriveBy: alt.arrive_by, pickupAt: alt.pickup ? alt.pickup_at : null, ...(pickupPlace ? { pickupPlace } : {}) };
}

export function buildDraftInput(prefill: ComposerPrefill, ctx: DraftInputContext): DraftInputResult {
  const request = ctx.requests.find((r) => r.id === prefill.requestId);
  if (!request) return { ok: false };
  const hostRide = prefill.rideId ? ctx.rides.find((ride) => ride.id === prefill.rideId) : undefined;
  const hint = typeof prefill.payload.hint === "string" ? externalHintFromSuggestion(prefill.payload.hint) : "cab";
  // Same switch as the composer: an external "waive" is stored as a plain denial.
  const type: ProposalType = prefill.type === "external" && hint === "waive" ? "deny" : prefill.type;
  const reasonRaw = typeof prefill.payload.reason === "string" ? prefill.payload.reason.trim() : "";
  const reason = reasonRaw || he.sadranProposal.defaultReason;

  const span = type === "shift" ? seriesSpanOf(prefill.payload) : null;
  const { departAt, returnAt } = span ? { departAt: span.depart_at, returnAt: span.return_at } : resolveShiftTimes(prefill.payload, request);
  // REQ §13.94 (G10): the merged ride keeps the host's start; its end grows by the added driving
  // (route twin). Only the message text shows this window - the payload carries legs only.
  const twinPreview = type === "merge" && hostRide && ctx.route ? previewMerge(hostRide, request, mergePayloadLeg(prefill.payload, request), ctx.route) : null;
  const mergedPreview = applyServerMergeTimes(twinPreview, ctx.serverMerge, request);
  const combinedStart = typeof prefill.payload.starts_at === "string" ? prefill.payload.starts_at : (mergedPreview?.startsAt ?? hostRide?.starts_at);
  const combinedEnd = typeof prefill.payload.ends_at === "string" ? prefill.payload.ends_at : (mergedPreview?.endsAt ?? hostRide?.ends_at);
  const originAway = !!request.origin_id && request.origin_id !== ctx.homeDestinationId;
  const payload = buildProposalPayload({
    type, prefillPayload: prefill.payload, request, rideId: prefill.rideId,
    proposedDepartAt: departAt, proposedReturnAt: returnAt, effectiveReason: reason, externalHint: hint, originAway,
  });
  if (!payload) return { ok: false };
  // REQ §13.100 c: a merge into a ride that still needs a driver is valid; only a missing host is not.
  if (type === "merge" && !hostRide) return { ok: false };

  const destinationName = ctx.destinations.find((d) => d.id === request.destination_id)?.name ?? request.destination_text ?? "";
  const route = routeLabel({
    destination: destinationName,
    origin: request.origin_resolved_name ?? request.origin_text ?? null,
    originIsHome: !request.origin_id ? !request.origin_text : request.origin_id === ctx.homeDestinationId,
  });
  const variant = proposalTemplateVariant(type, payload, {
    hostHasDriver: !!hostRide?.driver_id, originAway,
    destinationIsHome: !!ctx.homeDestinationId && request.destination_id === ctx.homeDestinationId,
    placed: request.status === "assigned" || request.status === "merged",
    timesUnchanged: type === "shift" && !span && !!payload.car_id && shiftTimesUnchanged({ type, request, proposedDepartAt: departAt, proposedReturnAt: returnAt }),
  });
  const template = variant ? ctx.templates.find((t) => t.variant === variant) : undefined;
  const originCarId = type === "origin" && typeof payload.car_id === "string" ? payload.car_id : undefined;
  const newOriginId = type === "origin" && typeof payload.origin_id === "string" ? payload.origin_id : undefined;
  const hostCarName = ctx.cars.find((c) => c.id === hostRide?.car_id)?.name ?? "";
  // REQ §13.101 j: a fewer-days shift says "instead of" the series' original first/last day.
  const seriesLegs = span && request.series_id ? ctx.requests.filter((r) => r.series_id === request.series_id) : [];
  const seriesOriginal = seriesOriginalOf(seriesLegs.map((r) => ({ departAt: r.depart_at, returnAt: r.return_at })));
  const reasonHe = proposalPreviewText({
    template, type, request, seriesOriginal,
    // R3B6: the text speaks of the legs actually merged (a return-only guest is collected, not driven out).
    mergeLeg: type === "merge" ? mergeLegSummary(payload, request) : undefined,
    requesterName: request.requester_full_name ?? undefined,
    sadranName: ctx.sadranName,
    destinationName, route,
    proposedDepartAt: departAt, proposedReturnAt: returnAt,
    carName: type === "origin" ? (ctx.cars.find((c) => c.id === originCarId)?.name ?? "") : hostCarName,
    origin: request.origin_resolved_name ?? "",
    newOrigin: ctx.destinations.find((d) => d.id === newOriginId)?.name ?? "",
    driverName: hostRide?.driver_name ?? "",
    reason,
    externalSuggestion: externalSuggestionFor(type, hint),
    alternative: type === "alternative" ? alternativeTextInput(request) : undefined,
    combined: type === "merge" && combinedStart && combinedEnd
      ? { start: combinedStart, end: combinedEnd, passengerName: request.requester_full_name ?? "", hostCarName, joinerOutAt: mergedPreview?.joinerOutAt, joinerReturnAt: mergedPreview?.joinerReturnAt }
      : null,
  });

  // A split merge (REQ §13.102 d) joins two rides: every host ride's driver and requesters consent.
  const hostRides = type === "merge"
    ? [...new Set([prefill.rideId, ...mergePayloadLegs(prefill.payload).map((entry) => entry.ride_id)])]
      .flatMap((id) => { const ride = ctx.rides.find((r) => r.id === id); return ride ? [ride] : []; })
    : [];
  const hostRequestIds = new Set(hostRides.flatMap((ride) => servedOf(ride).map((entry) => entry.request_id)));
  const partyProfileIds = type === "merge"
    ? [...new Set([
        ...hostRides.map((ride) => ride.driver_id),
        ...ctx.requests.filter((r) => hostRequestIds.has(r.id)).map((r) => r.requester_id),
      ].filter((id): id is string => !!id && id !== request.requester_id))]
    : [];

  return {
    ok: true,
    input: {
      requestId: request.id,
      rideId: prefill.rideId,
      type,
      payload: payload as unknown as Json,
      reasonHe,
      partyProfileIds,
    },
  };
}
