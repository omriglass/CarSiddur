// REQ §13.161 (d): "איך הגענו לכאן" - audit_log rows of one request (its rides and proposals) worded as short sentences.
import { he, t, tv, type TranslationKey } from "@/i18n/he";

import type { AuditLogRow } from "../api";

export interface HistoryLine {
  id: number;
  at: string;
  actor: string;
  what: string;
}

const ACTOR: Record<string, string> = {
  member: he.sadranLog.actorMember,
  sadran: he.sadranLog.actorSadran,
  admin: he.sadranLog.actorAdmin,
  system: he.sadranLog.actorSystem,
};

const PROPOSAL_STATUS_KEY: Record<string, TranslationKey> = {
  draft: "sadranLog.sentence.proposalDraft",
  sent: "sadranLog.sentence.proposalSent",
  accepted: "sadranLog.sentence.proposalAccepted",
  declined: "sadranLog.sentence.proposalDeclined",
  applied: "sadranLog.sentence.proposalApplied",
  withdrawn: "sadranLog.sentence.proposalWithdrawn",
  expired: "sadranLog.sentence.proposalExpired",
};

function afterOf(row: AuditLogRow): Record<string, unknown> {
  return row.after && typeof row.after === "object" && !Array.isArray(row.after) ? (row.after as Record<string, unknown>) : {};
}

function sentenceOf(row: AuditLogRow): string | null {
  const changed = row.changed_columns ?? [];
  const status = afterOf(row).status;
  if (row.table_name === "requests") {
    if (row.action === "insert") return t("sadranLog.sentence.requestInsert");
    if (typeof status === "string" && changed.includes("status") && status in he.status) {
      return tv("sadranLog.sentence.requestStatus", { status: he.status[status as keyof typeof he.status] });
    }
    if (changed.some((column) => ["depart_at", "return_at", "original_depart_at", "original_return_at"].includes(column))) return t("sadranLog.sentence.requestTimes");
    return t("sadranLog.sentence.requestUpdate");
  }
  if (row.table_name === "rides") {
    if (row.action === "insert") return t("sadranLog.sentence.rideInsert");
    if (row.action === "delete") return t("sadranLog.sentence.rideDelete");
    if (changed.includes("car_id")) return t("sadranLog.sentence.rideCar");
    if (changed.includes("starts_at") || changed.includes("ends_at")) return t("sadranLog.sentence.rideMoved");
    if (changed.includes("driver_id")) return t("sadranLog.sentence.rideDriver");
    return t("sadranLog.sentence.rideUpdate");
  }
  if (row.table_name === "proposals") {
    if (typeof status === "string" && (row.action === "insert" || changed.includes("status"))) return t(PROPOSAL_STATUS_KEY[status] ?? "sadranLog.sentence.proposalOther");
    return t("sadranLog.sentence.proposalOther");
  }
  return null;
}

/** Oldest first. `rideIds` / `proposalIds` are the ones that belong to the request. */
export function requestHistory(
  rows: readonly AuditLogRow[],
  ids: { requestId: string; rideIds: readonly string[]; proposalIds: readonly string[] },
): HistoryLine[] {
  const rides = new Set(ids.rideIds);
  const proposals = new Set(ids.proposalIds);
  const lines: HistoryLine[] = [];
  for (const row of rows) {
    const mine = (row.table_name === "requests" && row.row_id === ids.requestId)
      || (row.table_name === "rides" && rides.has(row.row_id))
      || (row.table_name === "proposals" && proposals.has(row.row_id));
    if (!mine) continue;
    const what = sentenceOf(row);
    if (what) lines.push({ id: row.id, at: row.at, actor: ACTOR[row.actor_role ?? "system"] ?? he.sadranLog.actorSystem, what });
  }
  return lines.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
}
