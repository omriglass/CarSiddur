// REQ §13.204: `request_history` events worded as short lines, oldest first (the member's "what happened?" and the
// Sadran's "request history" read the same lines).
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { describeStatusReason } from "@/lib/statusReason";
import { formatTime } from "@/lib/time";

import type { RequestHistoryEvent } from "./schema";

export interface TimelineLine {
  key: string;
  at: string;
  /** Who did it; `null` for a notice (the line says what was sent). */
  actor: string | null;
  what: string;
  /** A second line: the status reason, or the notice's text. */
  detail?: string;
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** "ד׳ 11.11 07:00–14:15" (the times isolated so they read left to right inside the Hebrew sentence). */
export function whenLabel(start: unknown, end?: unknown): string {
  const a = str(start);
  const b = str(end);
  const first = a ?? b;
  if (!first) return "";
  const range = a && b ? `${formatTime(new Date(a))}–${formatTime(new Date(b))}` : formatTime(new Date(first));
  return `${formatDayDate(first)} ⁦${range}⁩`;
}

function legSuffix(leg: unknown): string {
  return leg === "out" ? ` (${he.requestHistory.legOut})` : leg === "return" ? ` (${he.requestHistory.legReturn})` : "";
}

function statusLabel(status: string | null): string {
  return status && status in he.status ? he.status[status as keyof typeof he.status] : status ?? "";
}

const PROPOSAL = he.requestHistory.proposal;

function sentence(event: RequestHistoryEvent): Pick<TimelineLine, "what" | "detail"> | null {
  const d = event.data;
  switch (event.kind) {
    case "filed":
      return { what: tv("requestHistory.filed", { when: whenLabel(d.depart, d.return) }) };
    case "times":
      return { what: tv("requestHistory.times", { from: whenLabel(d.old_depart, d.old_return), to: whenLabel(d.depart, d.return) }) };
    case "status": {
      const closedReason = str(d.closed_reason);
      if (closedReason) return { what: tv("requestHistory.closed", { reason: closedReason }) };
      const reason = describeStatusReason(str(d.status_reason));
      return { what: tv("requestHistory.status", { status: statusLabel(str(d.status)) }), ...(reason ? { detail: reason } : {}) };
    }
    case "placed":
      return { what: tv("requestHistory.placed", { car: str(d.car) ?? "", when: whenLabel(d.starts, d.ends) }) + legSuffix(d.leg) };
    case "unplaced":
      return { what: tv("requestHistory.unplaced", { car: str(d.car) ?? "", when: whenLabel(d.starts, d.ends) }) + legSuffix(d.leg) };
    case "ride_car":
      return { what: tv("requestHistory.rideCar", { oldCar: str(d.old_car) ?? "", car: str(d.car) ?? "" }) };
    case "ride_times":
      return { what: tv("requestHistory.rideTimes", { from: whenLabel(d.old_starts, d.old_ends), to: whenLabel(d.starts, d.ends) }) };
    case "ride_cancelled":
      return { what: tv("requestHistory.rideCancelled", { car: str(d.car) ?? "" }) };
    case "proposal": {
      const status = str(d.status);
      return { what: status && status in PROPOSAL ? PROPOSAL[status as keyof typeof PROPOSAL] : PROPOSAL.other };
    }
    case "notice": {
      const body = str(d.body);
      return { what: tv("requestHistory.notice", { title: str(d.title) ?? "" }), ...(body ? { detail: body } : {}) };
    }
    default:
      return null;
  }
}

/** Oldest first; an event of a kind this build does not know is left out. */
export function requestTimeline(events: readonly RequestHistoryEvent[]): TimelineLine[] {
  return events.flatMap((event, index) => {
    const line = sentence(event);
    if (!line) return [];
    const actor = event.kind === "notice" ? null : event.actor ?? he.requestHistory.system;
    return [{ key: `${index}:${event.kind}`, at: event.at, actor, ...line }];
  });
}
