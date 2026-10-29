// REQ §13.161 (d): the change log's rows - one per request whose outcome differs from what it asked.
import { dateKey } from "@/lib/time";

import type { WeekRequestRow } from "../api";
import type { RequestDelta } from "../requestDelta";

export interface ChangeLogRow {
  request: WeekRequestRow;
  delta: RequestDelta;
  /** `yyyy-MM-dd` (Asia/Jerusalem) of the request's asked first time. */
  day: string;
  /** The ride the row opens on the board; `null` for a request with none. */
  rideId: string | null;
}

export interface ChangeLogFilters {
  /** Default on: only differences beyond the request's flexibility (and requests with no ride / a refusal). */
  onlyBeyondFlex: boolean;
  /** `null` = the whole week. */
  day: string | null;
  query: string;
}

const askedAt = (request: WeekRequestRow) =>
  request.original_depart_at ?? request.depart_at ?? request.original_return_at ?? request.return_at ?? null;

/** Every request worth a row (a difference, no ride, or a refusal), ordered by asked time then id. */
export function changeLogRows(requests: readonly WeekRequestRow[], deltas: ReadonlyMap<string, RequestDelta>, onlyBeyondFlex = true): ChangeLogRow[] {
  const rows: ChangeLogRow[] = [];
  for (const request of requests) {
    const delta = deltas.get(request.id);
    const asked = askedAt(request);
    if (!delta || !asked) continue;
    const outcome = delta.state !== "placed";
    if (!(outcome || (onlyBeyondFlex ? delta.beyondFlex : delta.anyDifference))) continue;
    rows.push({ request, delta, day: dateKey(asked), rideId: delta.rideIds[0] ?? null });
  }
  return rows.sort((a, b) => (askedAt(a.request) ?? "").localeCompare(askedAt(b.request) ?? "") || a.request.id.localeCompare(b.request.id));
}

export function filterChangeLogRows(rows: readonly ChangeLogRow[], filters: Pick<ChangeLogFilters, "day" | "query">): ChangeLogRow[] {
  const needle = filters.query.trim().toLowerCase();
  return rows.filter((row) => (!filters.day || row.day === filters.day)
    && (!needle || (row.request.requester_full_name ?? "").toLowerCase().includes(needle)));
}

/** REQ §13.162: the Sadran closed this request ("הנסיעה כבר לא רלוונטית"); only such a request offers "החזר לרשימת ההמתנה". */
export function isClosedBySadran(request: Pick<WeekRequestRow, "status" | "status_reason">): boolean {
  return request.status === "cancelled" && request.status_reason === "CLOSED_BY_SADRAN";
}

type AuditLike = { table_name: string; row_id: string; at: string; id: number; reason: string | null; before: unknown; after: unknown };
/** Reasons the close RPCs write when the Sadran gave none (not shown). */
const NO_REASON = new Set(["close_request", "sadran_cancel_ride", ""]);

function field(row: unknown, key: string): unknown {
  return row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>)[key] : undefined;
}

/** The Sadran's reason for the latest close of `requestId`, read from its closing audit row; `null` when none was given. */
export function closedReasonOf(audit: readonly AuditLike[], requestId: string): string | null {
  const closing = audit
    .filter((row) => row.table_name === "requests" && row.row_id === requestId
      && field(row.after, "status_reason") === "CLOSED_BY_SADRAN" && field(row.before, "status_reason") !== "CLOSED_BY_SADRAN")
    .sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id)[0];
  const reason = closing?.reason?.trim() ?? "";
  return NO_REASON.has(reason) ? null : reason;
}

/** Rows grouped by day, in order. */
export function groupRowsByDay(rows: readonly ChangeLogRow[]): { day: string; rows: ChangeLogRow[] }[] {
  const groups: { day: string; rows: ChangeLogRow[] }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last?.day === row.day) last.rows.push(row);
    else groups.push({ day: row.day, rows: [row] });
  }
  return groups;
}
