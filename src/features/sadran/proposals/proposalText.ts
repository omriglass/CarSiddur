// Pure rendering of a proposal's WhatsApp preview text, shared by the composer and the board's
// "draft" action (REQ §13.94): a draft saved from the board stores the same `reason_he` the
// composer would have, so opening it later and sending it behaves identically.
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";
import type { ProposalType } from "@/lib/enums";

import { renderTemplate } from "./waLink";

/**
 * `notification_templates.variant` (event `proposal_received`, channel `whatsapp`) per proposal type.
 * `external` has two variants (REQ §13.101 b): "every car is taken" (`external_none`, the default) and
 * "no car in your town" (`external_city`, payload `external_reason: 'city'`) - see `proposalTemplateVariant`.
 * There is deliberately no "use your own car" variant.
 */
export const PROPOSAL_TEMPLATE_VARIANT: Record<ProposalType, string | null> = {
  shift: "shift",
  merge: "merge_passenger",
  deny: "deny",
  external: "external_none",
  origin: "origin",
};

/**
 * The WhatsApp template variant for a proposal, honouring the external reason and, for a merge,
 * a host ride that still needs a driver (REQ §13.100 c - there is no driver to name).
 */
export function proposalTemplateVariant(
  type: ProposalType,
  payload?: Record<string, unknown> | null,
  opts?: { hostHasDriver?: boolean; originAway?: boolean; destinationIsHome?: boolean; placed?: boolean; timesUnchanged?: boolean },
): string | null {
  // "No car in your town" needs a list-place origin other than home (SQL `proposal_reader_vars`); when the trip
  // goes home there is no "get to the kibbutz yourself" advice (`external_city_home`, REQ §13.102 R2B10).
  if (type === "external" && (payload?.external_reason === "city" || opts?.originAway)) {
    return opts?.destinationIsHome ? "external_city_home" : "external_city";
  }
  // A member who already has a ride is offered a *move*, never "we could place you" (`shift_placed`/`origin_placed`).
  if (opts?.placed && (type === "shift" || type === "origin")) return `${type}_placed`;
  // R5B11: an unplaced member offered a car at their own times - "a car is free for you", not "if we move" (SQL `shift_same_times`).
  if (type === "shift" && opts?.timesUnchanged && payload?.car_id && !payload.series_span) return "shift_same_times";
  if (type === "merge" && opts?.hostHasDriver === false) return "merge_passenger_no_driver";
  // REQ §13.102 d: out on one ride, back on another - one proposal (`merge_passenger_split` in SQL).
  if (type === "merge" && Array.isArray(payload?.legs)
    && new Set((payload.legs as { ride_id?: unknown }[]).map((leg) => leg?.ride_id)).size > 1) return "merge_passenger_split";
  return PROPOSAL_TEMPLATE_VARIANT[type];
}

export interface ProposalTextInput {
  template: { body: string } | undefined;
  type: ProposalType;
  request: { depart_at: string | null; return_at: string | null } | undefined;
  requesterName: string | undefined;
  sadranName: string;
  destinationName: string;
  route: string;
  proposedDepartAt?: string | null;
  proposedReturnAt?: string | null;
  carName: string;
  origin: string;
  newOrigin: string;
  driverName: string;
  reason: string;
  externalSuggestion: string;
  /** Merge only: the combined window + names for the summary line. */
  combined?: { start: string; end: string; passengerName: string; hostCarName: string; joinerOutAt?: string | null; joinerReturnAt?: string | null } | null;
  /** Merge only: which of the request's legs join the ride (default both). */
  mergeLeg?: "out" | "return" | "both";
  /** Merge only: the added driving for the host ("כ-N דק׳ נוספות"), when known. */
  detourMin?: number;
  /**
   * Series span shift (REQ §13.101 j): the multi-day request's original first departure / last return. When set,
   * `proposedDepartAt`/`proposedReturnAt` are the span's and the time line names the days.
   */
  seriesOriginal?: { departAt: string; returnAt: string } | null;
}

function firstNameOf(fullName: string | undefined): string {
  return fullName?.split(" ")[0] ?? "";
}

/** "יציאה 11:15 במקום 11:30 · חזרה 17:00 במקום 17:30": only what differs; "" when nothing does. */
export function timeChangeLine(
  old: { depart?: string | null; return?: string | null },
  next: { depart?: string | null; return?: string | null },
  dayLevel = false,
): string {
  const part = (kind: "Depart" | "Return", from?: string | null, to?: string | null): string => {
    if (!to || from === to) return "";
    if (!from) return tv(`sadranProposal.time${kind}Set` as "sadranProposal.timeDepartSet", { new: formatTime(new Date(to)) });
    const day = dayLevel || (from ? formatDayDate(from) !== formatDayDate(to) : false);
    const label = (iso: string) => (day ? `${formatDayDate(iso)} ${formatTime(new Date(iso))}` : formatTime(new Date(iso)));
    return tv(`sadranProposal.time${kind}${day ? "Day" : ""}Change` as "sadranProposal.timeDepartChange", { new: label(to), old: from ? label(from) : "" });
  };
  return [part("Depart", old.depart, next.depart), part("Return", old.return, next.return)].filter(Boolean).join(" · ");
}

export function proposalTemplateVars(input: ProposalTextInput): Record<string, string> {
  const { request } = input;
  const firstName = firstNameOf(input.requesterName);
  const times = (iso: string | null | undefined) => (iso ? formatTime(new Date(iso)) : "");

  let timeChange = "";
  let carLine = "";
  let joinLine = "";
  let legWord = "";
  if (input.type === "shift") {
    const dayLevel = !!input.seriesOriginal;
    timeChange = timeChangeLine(
      { depart: input.seriesOriginal?.departAt ?? request?.depart_at, return: input.seriesOriginal?.returnAt ?? request?.return_at },
      { depart: input.proposedDepartAt, return: input.proposedReturnAt },
      dayLevel,
    );
    if (!timeChange) timeChange = input.carName ? tv("sadranProposal.sameTimesWithCar", { car: input.carName }) : he.sadranProposal.timeUnchanged;
    else if (input.carName) carLine = ` · ${input.carName}`;
  } else if (input.type === "merge") {
    const leg = input.mergeLeg ?? "both";
    // R4B5: the joiner's own boarding times (the server's merge_preview twin), never the ride's window.
    const depart = leg === "return" ? null : (input.combined?.joinerOutAt ?? request?.depart_at);
    const ret = leg === "out" ? null : (input.combined?.joinerReturnAt ?? request?.return_at);
    joinLine = tv(depart && ret ? "sadranProposal.joinBoth" : depart ? "sadranProposal.joinOut" : "sadranProposal.joinReturn", { depart: times(depart), return: times(ret) });
    timeChange = timeChangeLine({ depart: request?.depart_at, return: request?.return_at }, { depart, return: ret }) || he.sadranProposal.timeUnchanged;
    legWord = leg === "out" ? he.sadranProposal.legOut : leg === "return" ? he.sadranProposal.legReturn : he.sadranProposal.legBoth;
  }

  // The request's own window as text: "08:00–12:00", just the departure for a one-way, "חזרה ב16:00" for a return-only.
  const windowText = request?.depart_at && request.return_at ? `${times(request.depart_at)}–${times(request.return_at)}`
    : request?.depart_at ? times(request.depart_at)
    : request?.return_at ? tv("sadranProposal.windowReturn", { return: times(request.return_at) }) : "";

  // `{{link}}` is deliberately never a key: `renderTemplate` leaves unknown placeholders alone,
  // so the literal token survives into the preview and is substituted per recipient when the
  // WhatsApp message is built after sending (composer `waButtonFor`).
  return {
    firstName,
    sadranName: input.sadranName,
    byName: input.sadranName,
    destination: input.destinationName,
    route: input.route,
    day: request?.depart_at ? formatDayDate(request.depart_at) : "",
    // R5B11: a date never appears without its weekday.
    date: request?.depart_at ? formatDayDate(request.depart_at) : "",
    depart: times(request?.depart_at),
    return: times(request?.return_at),
    newDepart: times(input.proposedDepartAt),
    newReturn: times(input.proposedReturnAt),
    timeChange,
    carLine,
    joinLine,
    legWord,
    window: windowText,
    destinationRoute: tv("route.to", { destination: input.destinationName }),
    joinerName: input.requesterName ?? "",
    detourLine: input.detourMin ? tv("sadranProposal.detourLine", { detourMin: String(input.detourMin) }) : "",
    car: input.carName,
    origin: input.origin,
    originOrHome: input.origin,
    city: input.origin,
    newOrigin: input.newOrigin,
    driverName: input.driverName,
    passengerName: firstName,
    detourMin: input.detourMin ? String(input.detourMin) : "",
    reason: input.reason,
    reasonLine: input.reason ? tv("sadranProposal.reasonLine", { reason: input.reason }) : "",
    // Sits before the link (REQ §13.102 R2B10), never after it.
    reasonNote: input.reason ? `${tv("sadranProposal.reasonLine", { reason: input.reason })}\n` : "",
    externalSuggestion: input.externalSuggestion,
    expiresAt: "",
  };
}

export function combinedSummaryText(input: ProposalTextInput): string {
  if (input.type !== "merge" || !input.combined) return "";
  // R3B6: a return-only guest is collected *from* the destination; a ride still needing a driver names none.
  const key = input.driverName
    ? (input.mergeLeg === "return" ? "rideCoordination.combinedSummaryReturn" : "rideCoordination.combinedSummary")
    : (input.mergeLeg === "return" ? "rideCoordination.combinedSummaryReturnNoDriver" : "rideCoordination.combinedSummaryNoDriver");
  return tv(key, {
    driver: input.driverName,
    passenger: input.combined.passengerName,
    destination: input.destinationName,
    car: input.combined.hostCarName,
    start: formatTime(new Date(input.combined.start)),
    end: formatTime(new Date(input.combined.end)),
  });
}

/** A shift whose proposed times equal the request's own changes nothing about the times. */
export function shiftTimesUnchanged(input: Pick<ProposalTextInput, "type" | "request" | "proposedDepartAt" | "proposedReturnAt">): boolean {
  if (input.type !== "shift") return false;
  const { request } = input;
  const sameDepart = !input.proposedDepartAt || input.proposedDepartAt === request?.depart_at;
  const sameReturn = !input.proposedReturnAt || input.proposedReturnAt === request?.return_at;
  return sameDepart && sameReturn;
}

export function proposalPreviewText(input: ProposalTextInput): string {
  const { type, template } = input;
  if (!template) return "";
  return [
    combinedSummaryText(input),
    renderTemplate(template.body, proposalTemplateVars(input)),
    // Older/custom templates may not have these placeholders. Include the selected alternative
    // and optional explanation in the member's message.
    (type === "deny" || type === "external") && !template.body.includes("{{reason}}") && !template.body.includes("{{reasonLine}}") && !template.body.includes("{{reasonNote}}") ? input.reason : "",
    !template.body.includes("{{externalSuggestion}}") ? input.externalSuggestion : "",
  ].filter(Boolean).join("\n\n");
}

/** `he.sadranProposal.externalSuggestion` entry for a hint (falls back to "private"). */
export function externalSuggestionFor(type: ProposalType, hint: string): string {
  if (type !== "external") return "";
  return he.sadranProposal.externalSuggestion[hint as keyof typeof he.sadranProposal.externalSuggestion] ?? he.sadranProposal.externalSuggestion.private;
}
