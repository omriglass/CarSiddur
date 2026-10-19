import type { HeldNotice } from "../api";

/**
 * REQ §13.138 (e): one update per person and ride (or request) — what that person gets one message about.
 * `day` undefined = the whole week; `null` = only the week-level notices (no day).
 */
export function heldUpdateCount(held: readonly HeldNotice[], day?: string | null): number {
  return new Set(held.filter((row) => day === undefined || row.day === day)
    .map((row) => `${row.recipient_id}:${row.subject_kind}:${row.subject_id ?? row.id}`)).size;
}
