import { roundUpToQuarterHour } from "@/features/siddur/freeWindows";
import { dateKey, formatTime } from "@/lib/time";

import { endTimeForDuration } from "./duration";

/**
 * Pure helpers for the "car-now" flow (`RequestForm` `variant="carNow"`, UX_FLOWS.md §18/Home
 * §3.3): the flow is always about *today*, departing "now" rounded up to the next 15-minute
 * mark, for a member-chosen whole-hour duration (1–12h, default 2h). No React/Supabase — same
 * purity discipline as `features/siddur/freeWindows.ts`, which this module builds on.
 */

export const CAR_NOW_MIN_HOURS = 1;
export const CAR_NOW_MAX_HOURS = 12;
export const CAR_NOW_DEFAULT_HOURS = 2;
export const CAR_NOW_HOURS_OPTIONS: readonly number[] = Array.from(
  { length: CAR_NOW_MAX_HOURS - CAR_NOW_MIN_HOURS + 1 },
  (_, i) => CAR_NOW_MIN_HOURS + i,
);

/**
 * `now` rounded up to the next 15-minute mark. Delegates to `roundUpToQuarterHour` (epoch-ms
 * arithmetic is safe here — Asia/Jerusalem's UTC offset is always a whole number of hours,
 * never a fraction of 15 minutes, per that function's own doc comment).
 */
export function roundUpTo15(now: Date): Date {
  return new Date(roundUpToQuarterHour(now.getTime()));
}

export interface CarNowWindow {
  /** `yyyy-MM-dd`, Asia/Jerusalem — always today. */
  day: string;
  /** "HH:MM", 15-minute aligned. */
  departTime: string;
  /** "HH:MM", `departTime` + `hours`, capped at 23:59 (round trip only — no next-day rollover). */
  returnTime: string;
}

/** The car-now preset window: depart = `now` rounded up to the next quarter hour, return = depart + `hours`. */
export function carNowWindow(now: Date, hours: number): CarNowWindow {
  const departAt = roundUpTo15(now);
  const departTime = formatTime(departAt);
  return { day: dateKey(departAt), departTime, returnTime: endTimeForDuration(departTime, hours).time };
}
