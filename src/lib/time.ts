import { startOfWeek } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

/**
 * Every wall-clock calculation in this app happens in Asia/Jerusalem,
 * regardless of the device's own time zone (CLAUDE.md hard rule 6).
 * Never use `getHours()`/`getDay()`/`toLocale*` directly on a `Date`.
 */
export const TZ = "Asia/Jerusalem";

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
 * Formats an instant as a `yyyy-MM-dd` "day bucket" key in Asia/Jerusalem
 * local time — the canonical way to compare/group rides and requests by
 * calendar day. Use this instead of hand-writing
 * `formatInTimeZone(x, TZ, "yyyy-MM-dd")`.
 */
export function dateKey(instant: Date | string | number): string {
  return formatInTimeZone(instant, TZ, "yyyy-MM-dd");
}

/**
 * 0 (Sunday) .. 6 (Saturday) index of the Asia/Jerusalem-local weekday of
 * `instant`, matching the order of `he.days.short`/`he.days.long`. Pure index
 * math only — no Hebrew here; see `src/lib/dayLabels.ts` for the label
 * lookup (`src/lib/time.ts` stays i18n-free).
 */
export function weekdayIndex(instant: Date | string | number): number {
  return Number(formatInTimeZone(instant, TZ, "i")) % 7;
}
