// Pure rendering of a proposal's WhatsApp preview text, shared by the composer and the board's
// "draft" action (REQ §13.94): a draft saved from the board stores the same `reason_he` the
// composer would have, so opening it later and sending it behaves identically.
import { formatInTimeZone } from "date-fns-tz";

import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { TZ, formatTime } from "@/lib/time";
import type { ProposalType } from "@/lib/enums";

import { renderTemplate } from "./waLink";

/** `notification_templates.variant` (event `proposal_received`, channel `whatsapp`) per proposal type. */
export const PROPOSAL_TEMPLATE_VARIANT: Record<ProposalType, string | null> = {
  shift: "shift",
  merge: "merge_passenger",
  deny: "deny",
  // Stage 3 hardening fix #4 (DATA_MODEL.md §6.1 item 19): `external`'s WhatsApp copy
  // (UX_FLOWS.md §6.2 `wa.external`) is now seeded (`supabase/seed.sql`), so the composer
  // can look it up like every other type. `chauffeur` still has no dedicated proposal-type
  // value (SOLVER.md §3.15: it is sent as a `merge` proposal with `role: 'driver'`) and no
  // composer action yet — UX_FLOWS.md §15 item 6 records that as a separate, still-open gap.
  external: "external",
  // `origin` (REQ §13.93, ORIGINS_PLAN §3/§4, db-migrator O3 + ui-dev O4b): the solver's
  // `changeOrigin` suggestion is sent from the board's unmet list exactly like every other
  // suggestion kind; the WhatsApp copy is seeded (`supabase/seed.sql`, `20261004120000_...sql`).
  origin: "origin",
};

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
}

function firstNameOf(fullName: string | undefined): string {
  return fullName?.split(" ")[0] ?? "";
}

export function proposalTemplateVars(input: ProposalTextInput): Record<string, string> {
  const { request } = input;
  // `{{link}}` is deliberately never a key: `renderTemplate` leaves unknown placeholders alone,
  // so the literal token survives into the preview and is substituted per recipient when the
  // WhatsApp message is built after sending (composer `waButtonFor`).
  return {
    firstName: firstNameOf(input.requesterName),
    sadranName: input.sadranName,
    destination: input.destinationName,
    route: input.route,
    day: request?.depart_at ? formatDayDate(request.depart_at) : "",
    date: request?.depart_at ? formatInTimeZone(new Date(request.depart_at), TZ, "d.M") : "",
    depart: request?.depart_at ? formatTime(new Date(request.depart_at)) : "",
    return: request?.return_at ? formatTime(new Date(request.return_at)) : "",
    newDepart: input.proposedDepartAt ? formatTime(new Date(input.proposedDepartAt)) : "",
    newReturn: input.proposedReturnAt ? formatTime(new Date(input.proposedReturnAt)) : "",
    car: input.carName,
    origin: input.origin,
    newOrigin: input.newOrigin,
    driverName: input.driverName,
    passengerName: firstNameOf(input.requesterName),
    detourMin: "",
    reason: input.reason,
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

/** Drops template lines that phrase the (unchanged) times as a change; adds the car line instead. */
function withoutTimeChangeLines(body: string, carName: string): string {
  const lines = body.split("\n");
  const index = lines.findIndex((l) => l.includes("{{newDepart}}") || l.includes("{{newReturn}}"));
  if (index < 0) return body;
  lines[index] = carName ? tv("sadranProposal.sameTimesCar", { car: carName }) : "";
  return lines.filter((l, i) => i !== index || l).join("\n");
}

export function proposalPreviewText(input: ProposalTextInput): string {
  const { type } = input;
  const template = input.template && shiftTimesUnchanged(input)
    ? { body: withoutTimeChangeLines(input.template.body, input.carName) }
    : input.template;
  if (!template) return "";
  return [
    combinedSummaryText(input),
    renderTemplate(template.body, proposalTemplateVars(input)),
    // Older/custom templates may not have these placeholders. Include the selected alternative
    // and optional explanation in the member's message.
    (type === "deny" || type === "external") && !template.body.includes("{{reason}}") ? input.reason : "",
    !template.body.includes("{{externalSuggestion}}") ? input.externalSuggestion : "",
  ].filter(Boolean).join("\n\n");
}

/** `he.sadranProposal.externalSuggestion` entry for a hint (falls back to "private"). */
export function externalSuggestionFor(type: ProposalType, hint: string): string {
  if (type !== "external") return "";
  return he.sadranProposal.externalSuggestion[hint as keyof typeof he.sadranProposal.externalSuggestion] ?? he.sadranProposal.externalSuggestion.private;
}
