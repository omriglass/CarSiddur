import { startOfWeek } from "date-fns";
import { fromZonedTime, toDate, toZonedTime } from "date-fns-tz";

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

/**
 * O28-8 (board speed): the Asia/Jerusalem wall clock of an instant through ONE cached `Intl.DateTimeFormat`,
 * memoized per instant. `formatInTimeZone` re-parses the time zone on every call, and the board calls these
 * helpers thousands of times per refresh. Same results (`time.test.ts` compares them around both DST switches).
 */
const WALL_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WALL_CLOCK_CACHE_LIMIT = 20_000;

interface WallClock {
  key: string;
  time: string;
  weekday: number;
}

const wallClocks = new Map<number, WallClock>();

function epochMs(instant: Date | string | number): number {
  const ms = typeof instant === "string" ? toDate(instant).getTime() : typeof instant === "number" ? instant : instant.getTime();
  if (Number.isNaN(ms)) throw new RangeError("Invalid time value");
  return ms;
}

function wallClock(instant: Date | string | number): WallClock {
  const ms = epochMs(instant);
  const cached = wallClocks.get(ms);
  if (cached) return cached;
  const part: Record<string, string> = {};
  for (const { type, value } of WALL_CLOCK.formatToParts(ms)) part[type] = value;
  const clock: WallClock = {
    key: `${part.year}-${part.month}-${part.day}`,
    time: `${part.hour}:${part.minute}`,
    weekday: WEEKDAY_INDEX[part.weekday ?? ""] ?? 0,
  };
  if (wallClocks.size >= WALL_CLOCK_CACHE_LIMIT) wallClocks.clear();
  wallClocks.set(ms, clock);
  return clock;
}

/** Formats an instant as `HH:mm` in Asia/Jerusalem local time. */
export function formatTime(instant: Date): string {
  return wallClock(instant).time;
}

/**
 * Formats an instant as a `yyyy-MM-dd` "day bucket" key in Asia/Jerusalem
 * local time — the canonical way to compare/group rides and requests by
 * calendar day. Use this instead of hand-writing
 * `formatInTimeZone(x, TZ, "yyyy-MM-dd")`.
 */
export function dateKey(instant: Date | string | number): string {
  return wallClock(instant).key;
}

/**
 * 0 (Sunday) .. 6 (Saturday) index of the Asia/Jerusalem-local weekday of
 * `instant`, matching the order of `he.days.short`/`he.days.long`. Pure index
 * math only — no Hebrew here; see `src/lib/dayLabels.ts` for the label
 * lookup (`src/lib/time.ts` stays i18n-free).
 */
export function weekdayIndex(instant: Date | string | number): number {
  return wallClock(instant).weekday;
}
