import { differenceInCalendarDays, parseISO } from "date-fns";

/**
 * Multi-day ("series") request helpers (REQ §13.77, UX_FLOWS.md §3.3/§3.4). Pure — no
 * supabase/React imports — so `groupSeries`/`seriesSpanDays` are unit-testable on plain
 * objects; callers (`RequestsListPage.tsx`, `RequestForm.tsx`) supply the real row shape.
 */

export interface SeriesLike {
  seriesId?: string | null;
  seriesIndex?: number | null;
}

/**
 * Groups rows sharing a `seriesId` into one ordered array each (by `seriesIndex` ascending);
 * a row with no `seriesId` becomes its own single-row group. Preserves the position of each
 * group's first-seen row (a series' legs are fetched in `depart_at` order already, so they
 * arrive contiguous — this does not re-sort the top-level list).
 */
export function groupSeries<T extends SeriesLike>(rows: readonly T[]): T[][] {
  const groups: T[][] = [];
  const bySeriesId = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.seriesId) {
      groups.push([row]);
      continue;
    }
    let group = bySeriesId.get(row.seriesId);
    if (!group) {
      group = [];
      bySeriesId.set(row.seriesId, group);
      groups.push(group);
    }
    group.push(row);
  }
  for (const group of groups) group.sort((a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0));
  return groups;
}

/**
 * Inclusive calendar-day span between a `yyyy-MM-dd` departure day and a LATER `yyyy-MM-dd`
 * return day (`RequestForm`'s multi-day return-day picker, UX_FLOWS.md §3.4) — e.g. Monday to
 * Wednesday is 3 days. Mirrors `submit_series_request`'s own `(last_date - first_date) + 1`.
 */
export function seriesSpanDays(departDay: string, returnDay: string): number {
  return differenceInCalendarDays(parseISO(returnDay), parseISO(departDay)) + 1;
}
