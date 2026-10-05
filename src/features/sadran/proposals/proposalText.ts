// Pure rendering of a proposal's WhatsApp preview text, shared by the composer and the board's
// "draft" action (REQ §13.94): a draft saved from the board stores the same `reason_he` the
// composer would have, so opening it later and sending it behaves identically.
import { formatInTimeZone } from "date-fns-tz";

import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { TZ, formatTime } from "@/lib/time";
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
  opts?: { hostHasDriver?: boolean; originAway?: boolean },
): string | null {
  // "No car in your town" needs a list-place origin other than home (SQL `proposal_reader_vars`).
  if (type === "external" && (payload?.external_reason === "city" || opts?.originAway)) return "external_city";
  if (type === "merge" && opts?.hostHasDriver === false) return "merge_passenger_no_driver";
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
  combined?: { start: string; end: string; passengerName: string; hostCarName: string } | null;
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
    const depart = leg === "return" ? null : (input.combined?.start ?? request?.depart_at);
    const ret = leg === "out" ? null : (input.combined?.end ?? request?.return_at);
    joinLine = tv(depart && ret ? "sadranProposal.joinBoth" : depart ? "sadranProposal.joinOut" : "sadranProposal.joinReturn", { depart: times(depart), return: times(ret) });
    timeChange = timeChangeLine({ depart: request?.depart_at, return: request?.return_at }, { depart, return: ret }) || he.sadranProposal.timeUnchanged;
  }

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
    date: request?.depart_at ? formatInTimeZone(new Date(request.depart_at), TZ, "d.M") : "",
    depart: times(request?.depart_at),
    return: times(request?.return_at),
    newDepart: times(input.proposedDepartAt),
    newReturn: times(input.proposedReturnAt),
    timeChange,
    carLine,
    joinLine,
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
    externalSuggestion: input.externalSuggestion,
    expiresAt: "",
  };
}

export function combinedSummaryText(input: ProposalTextInput): string {
  if (input.type !== "merge" || !input.combined) return "";
  return tv("rideCoordination.combinedSummary", {
    driver: input.driverName,
    passenger: input.combined.passengerName,
    destination: input.destinationName,
    car: input.combined.hostCarName,
    start: formatTime(new Date(input.combined.start)),
    end: formatTime(new Date(input.combined.end)),
  });
}

/** A shift whose proposed times equal the request's own changes nothing about the times. */
export function shiftTimesUnchanged(input: ProposalTextInput): boolean {
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
    (type === "deny" || type === "external") && !template.body.includes("{{reason}}") && !template.body.includes("{{reasonLine}}") ? input.reason : "",
    !template.body.includes("{{externalSuggestion}}") ? input.externalSuggestion : "",
  ].filter(Boolean).join("\n\n");
}

/** `he.sadranProposal.externalSuggestion` entry for a hint (falls back to "private"). */
export function externalSuggestionFor(type: ProposalType, hint: string): string {
  if (type !== "external") return "";
  return he.sadranProposal.externalSuggestion[hint as keyof typeof he.sadranProposal.externalSuggestion] ?? he.sadranProposal.externalSuggestion.private;
}
