import { addDays, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

import { TZ } from "@/lib/time";

/**
 * SP1 (REQ item 228): splitting a multi-day ride. Pure: the days of the series and the `cut_after` positions sent to
 * `split_series` (1-based: cut after the k-th day).
 */
export type SplitMode = "two" | "daily";

/** The series' consecutive days ("yyyy-MM-dd"), from its first day and its length. */
export function seriesDays(firstDay: string, count: number): string[] {
  const start = parseISO(`${firstDay}T12:00:00Z`);
  return Array.from({ length: Math.max(0, count) }, (_, i) => formatInTimeZone(addDays(start, i), TZ, "yyyy-MM-dd"));
}

/** The first day of the series a day belongs to, given that day's 1-based index in it. */
export function seriesFirstDay(day: string, index: number): string {
  return formatInTimeZone(addDays(parseISO(`${day}T12:00:00Z`), -(Math.max(1, index) - 1)), TZ, "yyyy-MM-dd");
}

/** "in two": cut after day k (1..count-1); "daily": after every day. */
export function splitCuts(mode: SplitMode, count: number, at: number): number[] {
  if (count < 2) return [];
  if (mode === "daily") return Array.from({ length: count - 1 }, (_, i) => i + 1);
  return at >= 1 && at <= count - 1 ? [at] : [];
}

/** The parts the cuts make, as day lists (for the dialog's preview). */
export function splitParts(days: readonly string[], cuts: readonly number[]): string[][] {
  const bounds = [0, ...[...cuts].sort((a, b) => a - b), days.length];
  const parts: string[][] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) parts.push(days.slice(bounds[i], bounds[i + 1]));
  return parts.filter((part) => part.length > 0);
}
