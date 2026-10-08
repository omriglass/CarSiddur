// REQ §13.112 (c) / UX_FLOWS §3.4a "Time window": "צריך/ה רכב ל[4 שעות] בין [07:00] ל־[12:00]" — N hours of car
// time in ONE block, any time inside the window [A, B]. Pure helpers: the form fields (timeMode / windowHours /
// windowStart / windowEnd), their storage mapping (the earliest block + later-only slack + `duration_locked`),
// the edit prefill and the display label. No React.
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import { minutesToTime, timeToMinutes } from "./duration";

export const WINDOW_DEFAULT_HOURS = 4;
export const WINDOW_QUICK_HOURS = [1, 2, 3, 4, 5, 6] as const;
export const WINDOW_MAX_HOURS = 12;
/** The last quarter hour a window may end at (the stored slack is a quarter-hour multiple). */
export const WINDOW_LATEST_END = "23:45";
/** The earliest window start, like the outbound time field. */
export const WINDOW_EARLIEST_START = "06:00";

export type TimeMode = "fixed" | "window";

export interface WindowFields {
  timeMode?: TimeMode;
  windowHours?: number;
  windowStart?: string;
  windowEnd?: string;
}

/** What decides whether the window applies: round trip, one day (a series / one-way / הקפצה never has a window). */
export interface WindowScope {
  timeMode?: TimeMode;
  tripType?: string;
  tripShape?: string;
  day?: string;
  returnDay?: string;
}

/** Window mode is on: chosen, and the request is a single-day round trip. */
export function windowModeActive(scope: WindowScope): boolean {
  return scope.timeMode === "window"
    && scope.tripType === "round_trip"
    && scope.tripShape === "round_trip"
    && (!scope.returnDay || scope.returnDay === scope.day);
}

/** Whether the "יש לי חלון זמן?" link is offered at all. */
export function windowOffered(scope: Omit<WindowScope, "timeMode">): boolean {
  return windowModeActive({ ...scope, timeMode: "window" });
}

/** Minutes of slack: the window's length minus the block's. Negative = the window is shorter than the time needed. */
export function windowSlackMinutes(fields: Required<Pick<WindowFields, "windowHours" | "windowStart" | "windowEnd">>): number {
  return timeToMinutes(fields.windowEnd) - timeToMinutes(fields.windowStart) - fields.windowHours * 60;
}

export type WindowProblem = "missing" | "tooShort";

/** The first problem of a window in window mode, or `null`. */
export function windowProblem(fields: WindowFields): WindowProblem | null {
  const { windowHours, windowStart, windowEnd } = fields;
  if (!windowHours || !windowStart || !windowEnd) return "missing";
  return windowSlackMinutes({ windowHours, windowStart, windowEnd }) < 0 ? "tooShort" : null;
}

export interface WindowCarTimes {
  /** "HH:MM" — the earliest start (A). */
  departTime: string;
  /** "HH:MM" — the earliest block's end (A + N). */
  returnTime: string;
  slackMinutes: number;
}

/** The stored nominal block + slack of a valid window; `null` when the window has a problem. */
export function windowCarTimes(fields: WindowFields): WindowCarTimes | null {
  if (windowProblem(fields)) return null;
  const { windowHours, windowStart, windowEnd } = fields as Required<Pick<WindowFields, "windowHours" | "windowStart" | "windowEnd">>;
  const start = timeToMinutes(windowStart);
  return {
    departTime: windowStart,
    returnTime: minutesToTime(start + windowHours * 60),
    slackMinutes: windowSlackMinutes({ windowHours, windowStart, windowEnd }),
  };
}

/** A Postgres interval literal ("HH:MM:SS") for whole quarter hours — what `flex_*_late` carries. */
export function slackInterval(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

/**
 * The window a member starts from when they first tap "יש לי חלון זמן?": the hours they already typed (rounded
 * to whole hours, 1–12; 4 when the times do not say), starting at the outbound time and ending two hours after the block.
 */
export function defaultWindowFromFixed(fixed: { departTime?: string; returnTime?: string }): Required<Pick<WindowFields, "windowHours" | "windowStart" | "windowEnd">> {
  const windowStart = fixed.departTime ?? "08:00";
  let windowHours: number = WINDOW_DEFAULT_HOURS;
  if (fixed.departTime && fixed.returnTime) {
    const hours = Math.round((timeToMinutes(fixed.returnTime) - timeToMinutes(fixed.departTime)) / 60);
    if (hours >= 1 && hours <= WINDOW_MAX_HOURS) windowHours = hours;
  }
  const end = Math.min(timeToMinutes(windowStart) + windowHours * 60 + 120, timeToMinutes(WINDOW_LATEST_END));
  return { windowHours, windowStart, windowEnd: minutesToTime(end) };
}

/** The end time that keeps the same slack when the start or the hours change (never earlier than the block's end). */
export function windowEndKeepingSlack(
  before: Required<Pick<WindowFields, "windowHours" | "windowStart" | "windowEnd">>,
  next: { windowHours: number; windowStart: string },
): string {
  const slack = Math.max(0, windowSlackMinutes(before));
  const end = timeToMinutes(next.windowStart) + next.windowHours * 60 + slack;
  return minutesToTime(Math.min(end, timeToMinutes(WINDOW_LATEST_END)));
}

/** Interval text from Postgres ("03:15:00", "1 day", "1 day 02:00:00") in minutes. */
export function intervalMinutes(raw: string | null | undefined): number {
  if (!raw) return 0;
  const text = raw.trim().toLowerCase();
  const day = /(\d+)\s+day/.exec(text);
  const hms = /(\d+):(\d{2}):\d{2}/.exec(text);
  return (day ? Number(day[1]) * 1440 : 0) + (hms ? Number(hms[1]) * 60 + Number(hms[2]) : 0);
}

export interface StoredWindow {
  durationLocked?: boolean | null;
  departAt: string | null;
  returnAt: string | null;
  /** Both late flexes are equal on a window request; the return one is the end of the window. */
  flexReturnLate?: string | null;
}

/** The form fields of a stored window request, or `null` (not locked, or its length is not a whole number of hours 1–12). */
export function windowFromStored(row: StoredWindow, timeOf: (instant: string) => string = (instant) => formatTime(new Date(instant))): Required<Pick<WindowFields, "windowHours" | "windowStart" | "windowEnd">> | null {
  if (!row.durationLocked || !row.departAt || !row.returnAt) return null;
  const minutes = Math.round((Date.parse(row.returnAt) - Date.parse(row.departAt)) / 60_000);
  if (minutes < 60 || minutes > WINDOW_MAX_HOURS * 60 || minutes % 60 !== 0) return null;
  const end = Math.min(timeToMinutes(timeOf(row.returnAt)) + intervalMinutes(row.flexReturnLate), timeToMinutes(WINDOW_LATEST_END));
  return { windowHours: minutes / 60, windowStart: timeOf(row.departAt), windowEnd: minutesToTime(end) };
}

/** The window form fields of a stored window request (edit / template prefill): window mode with its hours and times, else nothing. */
export function windowFormFields(row: StoredWindow): WindowFields {
  const window = windowFromStored(row);
  return window ? { timeMode: "window", ...window } : {};
}

/** "שעה" / "שעתיים" / "4 שעות". */
export function windowHoursLabel(hours: number): string {
  if (hours === 1) return he.requestSentence.window.hour;
  if (hours === 2) return he.requestSentence.window.twoHours;
  return tv("requestSentence.window.hours", { n: String(hours) });
}

/**
 * "4 שעות בין 07:00 ל־12:00" for a stored window request (`/my` row, board unmet card, request details), or
 * `null` for an ordinary request.
 */
export function windowSummary(row: StoredWindow): string | null {
  const fields = windowFromStored(row);
  if (!fields) return null;
  return tv("requestSentence.window.summary", {
    hours: windowHoursLabel(fields.windowHours),
    start: fields.windowStart,
    end: fields.windowEnd,
  });
}
