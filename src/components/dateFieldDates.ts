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

const LRI = "\u2066"; // left-to-right isolate
const PDI = "\u2069"; // pop directional isolate

/**
 * `"18–24.10"` (one month) or `"28.9–4.10"` (across months) — the Sunday–Saturday range, wrapped in
 * a left-to-right isolate so it reads start-to-end inside RTL text and headers (a bare
 * `"24.10 – 18.10"` rendering was the bug); callers need no `dir` of their own.
 */
export function formatWeekRangeLabel(weekStart: string): string {
  const start = parseISO(weekStart);
  const end = addDays(start, 6);
  const sameMonth = format(start, "M") === format(end, "M");
  const range = `${sameMonth ? format(start, "d") : format(start, "d.M")}–${format(end, "d.M")}`;
  return `${LRI}${range}${PDI}`;
}
