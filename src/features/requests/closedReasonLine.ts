import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { describeStatusReason } from "@/lib/statusReason";
import { formatTime } from "@/lib/time";

import type { ClosedRequestRow } from "./api";

/**
 * Why it closed. DP1-7 (owner 2026-11-26): a withdrawal names who did it — every withdrawal is stored as "by the
 * member", so "הוסרה על ידך" is right only when the viewer did it — and every closed row says when.
 */
export function closedReasonLine(row: ClosedRequestRow): string {
  const base = describeStatusReason(row.statusReason) ?? he.status[row.status];
  const reason = row.statusReason === "WITHDRAWN_BY_MEMBER" && !row.closedByMe && row.closedByName
    ? tv("request.closedByOther", { name: row.closedByName })
    : base;
  if (!row.closedAt) return reason;
  return tv("request.closedWhen", { reason, when: `${formatDayDate(row.closedAt)} \u2066${formatTime(new Date(row.closedAt))}\u2069` });
}
