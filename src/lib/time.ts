import { startOfWeek } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

/**
 * Every wall-clock calculation in this app happens in Asia/Jerusalem,
 * regardless of the device's own time zone (CLAUDE.md hard rule 6).
 * Never use `getHours()`/`getDay()`/`toLocale*` directly on a `Date`.
 */
export const TZ = "Asia/Jerusalem";

const MINUTES_15_MS = 15 * 60 * 1000;

/**
 * Returns the instant (UTC) corresponding to local midnight on the Sunday
 * that starts the Asia/Jerusalem week containing `instant`. This is the
 * `week_start` key used throughout the schema (a `date`, no time zone) —
 * format the result with `formatInTimeZone(result, TZ, 'yyyy-MM-dd')` to get
 * that key.
 *
 * DST-safe: the calculation is done entirely on "zoned" wall-clock values
 * (via `toZonedTime`) so a spring-forward/fall-back transition elsewhere in
 * the week never shifts which Sunday is returned.
 */
export function weekStartFor(instant: Date): Date {
  const zoned = toZonedTime(instant, TZ);
  const zonedWeekStart = startOfWeek(zoned, { weekStartsOn: 0 });
  return fromZonedTime(zonedWeekStart, TZ);
}

/** Formats an instant as `HH:mm` in Asia/Jerusalem local time. */
export function formatTime(instant: Date): string {
  return formatInTimeZone(instant, TZ, "HH:mm");
}

/**
 * Rounds an instant to the nearest 15 minutes of Asia/Jerusalem wall-clock
 * time (the app's universal scheduling grid, ARCHITECTURE.md §11). Ties
 * round up. DST-safe for the same reason as `weekStartFor`: rounding happens
 * on the zoned representation, not on the raw UTC epoch.
 */
export function roundTo15(instant: Date): Date {
  const zoned = toZonedTime(instant, TZ);
  const roundedMs = Math.round(zoned.getTime() / MINUTES_15_MS) * MINUTES_15_MS;
  return fromZonedTime(new Date(roundedMs), TZ);
}
