// REQ §13.204 (d): /my lists each week's closed requests under that week's rides.
import type { ClosedRequestRow } from "./api";

export const weekGroupKey = (weekStart: string, departmentId: string): string => `${weekStart}:${departmentId}`;

/** Closed requests by `weekGroupKey`, weeks in order, each week's requests by day. */
export function closedByWeek(rows: readonly ClosedRequestRow[]): Map<string, ClosedRequestRow[]> {
  const byWeek = new Map<string, ClosedRequestRow[]>();
  const sorted = [...rows].sort((a, b) => a.weekStart.localeCompare(b.weekStart)
    || (a.departAt ?? a.returnAt ?? "").localeCompare(b.departAt ?? b.returnAt ?? "") || a.id.localeCompare(b.id));
  for (const row of sorted) {
    const key = weekGroupKey(row.weekStart, row.departmentId);
    byWeek.set(key, [...(byWeek.get(key) ?? []), row]);
  }
  return byWeek;
}
