// "My rides" week view (owner 2026-10-11): the grid has one column per day, so every item is cut into per-day
// segments of minutes since Jerusalem midnight. All wall-clock reading goes through `src/lib/time.ts`.
import { dateKey, formatTime } from "@/lib/time";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DAY_MINUTES = 24 * 60;

/** `yyyy-MM-dd` of `weekStart` plus `n` calendar days (noon UTC arithmetic: a DST change never moves the date). */
export function addDaysToKey(key: string, n: number): string {
  return dateKey(Date.parse(`${key}T12:00:00Z`) + n * DAY_MS);
}

/** The seven day keys of a week, Sunday first. */
export function weekDayKeys(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysToKey(weekStart, i));
}

/** Minutes since local (Jerusalem) midnight of an instant. */
export function minutesOfDay(instant: string | number | Date): number {
  const [h, m] = formatTime(new Date(instant)).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export interface DaySegment {
  dayKey: string;
  startMinutes: number;
  endMinutes: number;
}

/**
 * Cuts `[startIso, endIso)` into per-day segments, keeping only the days in `dayKeys`. A span ending at or before its
 * start is given `fallbackMinutes` (a request with a single time has no length of its own). A span reaching exactly
 * midnight ends at 24:00 of its last day instead of opening an empty segment on the next one.
 */
export function daySegments(startIso: string, endIso: string | null | undefined, dayKeys: readonly string[], fallbackMinutes = 60): DaySegment[] {
  const startMs = Date.parse(startIso);
  if (Number.isNaN(startMs)) return [];
  let endMs = endIso ? Date.parse(endIso) : Number.NaN;
  if (Number.isNaN(endMs) || endMs <= startMs) endMs = startMs + fallbackMinutes * 60_000;
  const firstKey = dateKey(startMs);
  const lastKey = dateKey(endMs);
  const startMinutes = minutesOfDay(startMs);
  const endMinutesOnLast = minutesOfDay(endMs);
  const wanted = new Set(dayKeys);
  const segments: DaySegment[] = [];
  let key = firstKey;
  // A span is never longer than a few days; the bound only guards against a corrupt value.
  for (let guard = 0; guard < 16; guard++) {
    const isFirst = key === firstKey;
    const isLast = key === lastKey;
    const segment: DaySegment = {
      dayKey: key,
      startMinutes: isFirst ? startMinutes : 0,
      endMinutes: isLast ? endMinutesOnLast : DAY_MINUTES,
    };
    if (segment.endMinutes > segment.startMinutes && wanted.has(key)) segments.push(segment);
    if (isLast) break;
    key = addDaysToKey(key, 1);
  }
  return segments;
}
