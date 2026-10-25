import { addDays, format, parseISO } from "date-fns";

import { isPastWeek } from "@/lib/pastWeek";

import type { Week } from "./api";

export { isPastWeek };

/**
 * The archive's date search (owner 2026-10-25): weeks (Sunday..Saturday) overlapping `from`..`to` (`yyyy-MM-dd`).
 * Only `from` = the week containing that date; neither = every week.
 */
export function weeksInDateRange<W extends Pick<Week, "week_start">>(weeks: readonly W[], from?: string | null, to?: string | null): W[] {
  if (!from && !to) return [...weeks];
  const lo = from || to!;
  const hi = to && to >= lo ? to : lo;
  return weeks.filter((w) => w.week_start <= hi && format(addDays(parseISO(w.week_start), 6), "yyyy-MM-dd") >= lo);
}

/** Past weeks only, newest first — the data behind `SiddurArchivePage`. */
export function pastWeeks<W extends Pick<Week, "week_start" | "phase">>(
  weeks: readonly W[],
  todayDateKey: string,
): W[] {
  return weeks.filter((w) => isPastWeek(w, todayDateKey)).sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
}
