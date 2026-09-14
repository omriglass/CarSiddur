import { addDays, format, parseISO } from "date-fns";

import { dateKey } from "@/lib/time";

/** `count` consecutive calendar dates (`yyyy-MM-dd`) starting at `start` (also `yyyy-MM-dd`). */
export function datesFrom(start: string, count: number): string[] {
  const startDate = parseISO(start);
  return Array.from({ length: count }, (_, i) => format(addDays(startDate, i), "yyyy-MM-dd"));
}

/** The 7 calendar dates (`yyyy-MM-dd`) of the week starting `weekStart` (a Sunday). */
export function datesOfWeek(weekStart: string): string[] {
  return datesFrom(weekStart, 7);
}

/** Asia/Jerusalem "today" as `yyyy-MM-dd` (hard rule 6: never raw device time). */
export function todayInJerusalem(): string {
  return dateKey(new Date());
}

/** `"14.9 – 20.9"` — an unambiguous, direction-safe week-range label for RTL headers/switchers. */
export function formatWeekRangeLabel(weekStart: string): string {
  const start = parseISO(weekStart);
  const end = addDays(start, 6);
  return `${format(start, "d.M")} – ${format(end, "d.M")}`;
}
