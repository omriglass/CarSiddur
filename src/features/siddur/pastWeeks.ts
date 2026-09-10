import { parseISO } from "date-fns";

import { dateKey, weekStartFor } from "@/lib/time";

import type { Week } from "./api";

/**
 * "Past" for the week strip / week-switcher navigation (owner decision,
 * Archive of past siddurs, 2026-09-10): a week is past once its own
 * `week_start` precedes the Jerusalem week containing today, **or** its
 * phase is already `archived` — whichever comes first. `advance_week_phases()`
 * (`supabase/migrations/20260908122000_week_opening.sql`) only flips
 * `published`/`live` → `archived` once `week_start + 7 <= today` (i.e. at the
 * next Sunday, the same instant the date rule below fires), so the two
 * conditions normally agree; the `phase === 'archived'` half only matters if
 * the 15-minute cron tick is briefly behind wall-clock time.
 */
export function isPastWeek(week: Pick<Week, "week_start" | "phase">, todayDateKey: string): boolean {
  const thisWeekStart = dateKey(weekStartFor(parseISO(todayDateKey)));
  return week.week_start < thisWeekStart || week.phase === "archived";
}

/** Past weeks only, newest first — the data behind `SiddurArchivePage`. */
export function pastWeeks<W extends Pick<Week, "week_start" | "phase">>(
  weeks: readonly W[],
  todayDateKey: string,
): W[] {
  return weeks.filter((w) => isPastWeek(w, todayDateKey)).sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
}
