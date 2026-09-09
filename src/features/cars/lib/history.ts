import { dateKey } from "@/lib/time";

import type { CarCareEventWithReporter, CarIssueWithReporter } from "../api";

import type { Database } from "@/integrations/supabase/types";

type CarIssueCategory = Database["public"]["Enums"]["car_issue_category"];
type CarIssueStatus = Database["public"]["Enums"]["car_issue_status"];
type TireState = Database["public"]["Enums"]["tire_state"];

export interface TireStates {
  front_left: TireState;
  front_right: TireState;
  rear_left: TireState;
  rear_right: TireState;
  spare: TireState;
}

const TIRE_KEYS: readonly (keyof TireStates)[] = ["front_left", "front_right", "rear_left", "rear_right", "spare"];

/** `car_care_events.tires` is untyped `jsonb` — validate its shape before trusting it (defensive, matches the SQL-side validation in `log_car_care()`). */
export function parseTireStates(value: unknown): TireStates | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const result = {} as TireStates;
  for (const key of TIRE_KEYS) {
    const state = record[key];
    if (state !== "ok" && state !== "low" && state !== "very_low") return null;
    result[key] = state;
  }
  return result;
}

/** One row of the merged, date-descending car history list (`CarManageScreen`'s History section). */
export type CarHistoryKind = "issue" | "tire_fill" | "wash";

export interface CarHistoryEntry {
  id: string;
  kind: CarHistoryKind;
  createdAt: string;
  reporterId: string;
  reporterName: string | null;
  category?: CarIssueCategory | null;
  description?: string;
  status?: CarIssueStatus;
  isUnsafe?: boolean;
  tires?: TireStates | null;
  note?: string | null;
}

/** Merges issues and care events into one date-descending list, `id` tie-break for determinism. */
export function mergeCarHistory(
  issues: readonly CarIssueWithReporter[],
  careEvents: readonly CarCareEventWithReporter[],
): CarHistoryEntry[] {
  const entries: CarHistoryEntry[] = [
    ...issues.map((issue) => ({
      id: issue.id,
      kind: "issue" as const,
      createdAt: issue.created_at,
      reporterId: issue.reported_by,
      reporterName: issue.reported_by_profile?.full_name ?? null,
      category: issue.category,
      description: issue.description,
      status: issue.status,
      isUnsafe: issue.is_unsafe,
    })),
    ...careEvents.map((event) => ({
      id: event.id,
      kind: event.kind,
      createdAt: event.created_at,
      reporterId: event.reported_by,
      reporterName: event.reported_by_profile?.full_name ?? null,
      tires: parseTireStates(event.tires),
      note: event.note,
    })),
  ];
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export type CarHistoryFilter = "all" | CarHistoryKind;

export interface CarHistoryDateRange {
  /** Inclusive, local calendar-day comparison against `dateKey(entry.createdAt)` (`src/lib/time.ts`). */
  from?: string;
  to?: string;
}

/** Applies the kind-chip and date-range filters (both optional, both AND-combined). `range` bounds are `dateKey`-shaped (`yyyy-MM-dd`, Asia/Jerusalem local day, `src/lib/time.ts`). */
export function filterCarHistory(
  entries: readonly CarHistoryEntry[],
  filter: CarHistoryFilter,
  range: CarHistoryDateRange = {},
): CarHistoryEntry[] {
  return entries.filter((entry) => {
    if (filter !== "all" && entry.kind !== filter) return false;
    const day = dateKey(entry.createdAt);
    if (range.from && day < range.from) return false;
    if (range.to && day > range.to) return false;
    return true;
  });
}
