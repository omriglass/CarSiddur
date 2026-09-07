/**
 * Duration-chip -> end-time mapping for the quick-request sheet (UX_FLOWS.md §18):
 * "1h / 2h / 3h / 4h" chips plus a "custom" escape hatch that lets the member pick an
 * explicit end time via `TimeField15` instead. Pure minutes-since-midnight arithmetic (no
 * `Date`/timezone) — mirrors `TimeField15`'s own "HH:MM" 15-minute grid and `RequestForm`'s
 * `returnNextDay` idiom for a window that crosses midnight (a `4h` quick request starting
 * after 20:00 does, so it is handled rather than assumed away).
 */
export const QUICK_REQUEST_DURATION_HOURS = [1, 2, 3, 4] as const;
export type QuickRequestDurationHours = (typeof QUICK_REQUEST_DURATION_HOURS)[number];
export type QuickRequestDuration = QuickRequestDurationHours | "custom";

const MINUTES_PER_DAY = 24 * 60;

function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minutesToTime(value: number): string {
  const h = Math.floor(value / 60);
  const m = value % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface DurationEnd {
  /** "HH:MM" */
  time: string;
  /** True when the computed end lands the day after `start`'s own day (midnight rollover). */
  nextDay: boolean;
}

/** `start` ("HH:MM") + a duration chip (whole hours) -> end ("HH:MM"), flagging a midnight rollover. */
export function endTimeForDuration(start: string, hours: QuickRequestDurationHours): DurationEnd {
  const totalMinutes = timeToMinutes(start) + hours * 60;
  const nextDay = totalMinutes >= MINUTES_PER_DAY;
  const normalized = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return { time: minutesToTime(normalized), nextDay };
}
