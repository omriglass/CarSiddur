import { addDays, format, parseISO } from "date-fns";

import { dateKey } from "@/lib/time";

/** `count` consecutive calendar dates (`yyyy-MM-dd`) starting at `start` (also `yyyy-MM-dd`). */
export function datesFrom(start: string, count: number): string[] {
  const startDate = parseISO(start);
  return Array.from({ length: count }, (_, i) => format(addDays(startDate, i), "yyyy-MM-dd"));
}

/** 0 (Sunday) .. 6 (Saturday) of a calendar date `yyyy-MM-dd` — the date itself, independent of any time zone. */
export function weekdayOfDate(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export interface CalendarCell {
  date: string;
  /** False for the padding before `first` / after the last day: shown greyed so the columns stay Sunday..Saturday. */
  selectable: boolean;
}

/**
 * `count` selectable days from `first`, laid out in whole Sunday..Saturday weeks: a range starting on a
 * Thursday shows Sunday–Wednesday greyed before it (owner 2026-10-13: a multi-day return picker starting
 * mid-week labelled its first day "Sunday").
 */
export function calendarCells(first: string, count: number): CalendarCell[] {
  const lead = weekdayOfDate(first);
  const last = format(addDays(parseISO(first), count - 1), "yyyy-MM-dd");
  const trail = 6 - weekdayOfDate(last);
  const start = format(addDays(parseISO(first), -lead), "yyyy-MM-dd");
  return datesFrom(start, lead + count + trail).map((date, i) => ({ date, selectable: i >= lead && i < lead + count }));
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
/** The archive's week label with the year (owner 2026-10-25): "18–24.10.2026", "27.9–3.10.2026", "28.12.2025–3.1.2026". */
export function formatWeekRangeLabelWithYear(weekStart: string): string {
  const start = parseISO(weekStart);
  const end = addDays(start, 6);
  const sameYear = format(start, "yyyy") === format(end, "yyyy");
  const sameMonth = sameYear && format(start, "M") === format(end, "M");
  const from = sameMonth ? format(start, "d") : sameYear ? format(start, "d.M") : format(start, "d.M.yyyy");
  return `${LRI}${from}–${format(end, "d.M.yyyy")}${PDI}`;
}

export function formatWeekRangeLabel(weekStart: string): string {
  const start = parseISO(weekStart);
  const end = addDays(start, 6);
  const sameMonth = format(start, "M") === format(end, "M");
  const range = `${sameMonth ? format(start, "d") : format(start, "d.M")}–${format(end, "d.M")}`;
  return `${LRI}${range}${PDI}`;
}
