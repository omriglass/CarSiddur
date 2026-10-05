import { he } from "@/i18n/he";
import { routeLabel } from "@/lib/routeLabel";
import { routeStopNames } from "@/lib/routeStops";
import type { MyRequestRow } from "./api";
import { groupSeries } from "./series";

/**
 * Pure row-shaping helpers for the member's own request list, shared by `/my` (Home,
 * `src/pages/HomePage.tsx`) and `/my/history` (`src/pages/MyHistoryPage.tsx`) — moved here from
 * the now-deleted `RequestsListPage.tsx` (REQ §13 item 91, owner 2026-09-16, E3: one "my rides"
 * screen) rather than duplicated between the two pages.
 */

/** Mirrors `freed_slot_candidates()`'s own `status in ('waitlisted','denied')` filter
 * (supabase/migrations/20260907091100_freed_slots.sql) — only these statuses are ever
 * eligible to be offered a freed slot, so the opt-out toggle is only meaningful here. */
export const FREED_SLOT_ELIGIBLE_STATUSES = new Set<MyRequestRow["status"]>(["waitlisted", "denied"]);

/** "הפוך/י לחוזר" is only meaningful once the request is a real, still-relevant filing —
 * mirrors the statuses a repeating request could plausibly resubmit as (REQ §76). */
export const MAKE_REPEATING_STATUSES = new Set<MyRequestRow["status"]>(["submitted", "assigned"]);

/**
 * "מ<origin> ל<destination>" / "מ<origin> דרך <stops> ל<destination>" (REQ §13.93, §13.93
 * "Multi-stop rides") — the origin is shown only when it is not the department home (a
 * free-text origin always shows its own text; `homeDestinationId` is `/my`'s per-department
 * `departments.home_destination_id` map, `undefined` while it has not loaded yet). Out-stop
 * names (never return-stops — REQ §13.93 "Multi-stop rides" Display keeps the one-line label
 * to the outbound route only) are listed via the shared `routeLabel()`.
 */
export function originDestinationLabel(
  row: Pick<MyRequestRow, "originId" | "originText" | "originName" | "destination" | "stops">,
  homeDestinationId: string | null | undefined,
): string {
  const originLabel = row.originName ?? row.originText ?? "";
  if (!originLabel) return row.destination;
  const originIsHome = !!row.originId && row.originId === homeDestinationId;
  const stops = routeStopNames(row.stops ?? [], "out");
  // The mundane case (home origin, no stops) stays the bare destination, exactly as before
  // out-stops existed — `routeLabel()`'s own "ל<destination>" template is for a leg that
  // genuinely has something worth naming before the destination (a non-home origin or a stop).
  if (originIsHome && !stops.length) return row.destination;
  return routeLabel({ destination: row.destination, origin: originLabel, originIsHome, stops });
}

export function requestStart(row: MyRequestRow): number {
  const instant = row.ride?.startsAt ?? row.departAt ?? row.returnAt;
  return instant ? new Date(instant).getTime() : Number.POSITIVE_INFINITY;
}

/**
 * One "card" per multi-day request ("series", REQ §13.77) — every other leg's fields fold
 * into the first leg's: `returnAt` becomes the LAST leg's return (the full span), `ride`
 * prefers whichever leg is actually assigned (all legs share one car and status once placed,
 * but a fresh submission's legs may not have resolved yet). `seriesLegs` (all legs, day order)
 * marks a display row as a series; withdraw/cancel act on the first leg's id/ride — the
 * server cascades to every day (`withdraw_request`/`cancel_ride`).
 */
export interface DisplayRow extends MyRequestRow {
  seriesLegs?: MyRequestRow[];
}

export function toDisplayRows(rows: readonly MyRequestRow[]): DisplayRow[] {
  return groupSeries(rows).map((legs): DisplayRow => {
    const first = legs[0]!;
    if (legs.length === 1) return first;
    const last = legs[legs.length - 1]!;
    return {
      ...first,
      returnAt: last.returnAt ?? last.departAt,
      ride: legs.find((leg) => leg.ride)?.ride ?? null,
      seriesLegs: legs,
    };
  });
}

export type ConfirmAction =
  | { kind: "withdraw"; row: DisplayRow }
  | { kind: "cancel"; row: DisplayRow }
  | { kind: "withdrawFreedClaim"; offerId: string; requestId: string }
  | { kind: "withdrawAll"; departmentId: string; weekStart: string };

export function confirmDialogTitle(action: ConfirmAction | null): string {
  if (!action) return "";
  if (action.kind === "withdrawAll") return he.requestsList.withdrawAllTitle;
  if (action.kind === "withdrawFreedClaim") return he.freedSlot.withdrawClaimTitle;
  return action.kind === "withdraw" ? he.request.withdrawConfirmTitle : he.request.cancelConfirmTitle;
}

export function confirmDialogDescription(action: ConfirmAction | null): string {
  if (!action) return "";
  if (action.kind === "withdrawAll") return he.requestsList.withdrawAllBody;
  if (action.kind === "withdrawFreedClaim") return he.freedSlot.withdrawClaimBody;
  const base = action.kind === "withdraw" ? he.request.withdrawConfirmBody : he.rideCoordination.cancelHelp;
  return action.row.seriesLegs ? `${base} ${he.request.seriesCancelBody}` : base;
}

/** Groups display rows by `(weekStart, departmentId)`, newest week first — used by
 * `/my/history` (`src/pages/MyHistoryPage.tsx`); rows within a week keep `requestStart` order. */
export function groupByWeek(rows: readonly DisplayRow[]): { weekStart: string; departmentId: string; rows: DisplayRow[] }[] {
  const byWeek = new Map<string, DisplayRow[]>();
  for (const row of rows) {
    const key = `${row.weekStart}:${row.departmentId}`;
    const list = byWeek.get(key) ?? [];
    list.push(row);
    byWeek.set(key, list);
  }
  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([, weekRows]) => ({
      weekStart: weekRows[0]!.weekStart,
      departmentId: weekRows[0]!.departmentId,
      rows: weekRows.sort((a, b) => requestStart(a) - requestStart(b) || a.id.localeCompare(b.id)),
    }));
}

export function confirmDialogLabel(action: ConfirmAction | null): string {
  if (!action) return "";
  if (action.kind === "withdrawAll") return he.requestsList.withdrawAll;
  if (action.kind === "withdrawFreedClaim") return he.requestsList.withdrawClaim;
  return action.kind === "withdraw" ? he.requestsList.withdraw : he.requestsList.cancelRide;
}
