import { he } from "@/i18n/he";
import { TZ, weekdayIndex } from "@/lib/time";
import { formatInTimeZone } from "date-fns-tz";

/**
 * Hebrew weekday name for an instant, Asia/Jerusalem-zoned. Single source for
 * the `he.days.long[Number(formatInTimeZone(x, TZ, "i")) % 7]` pattern that
 * used to be re-implemented at each call site (REFACTOR_BACKLOG.md 1.1).
 *
 * Kept out of `src/lib/time.ts` so that module stays free of `src/i18n`
 * imports; the index math itself lives in `time.ts` (`weekdayIndex`).
 */
export function weekdayLabel(instant: Date | string | number, style: "long" | "short" = "long"): string {
  return he.days[style][weekdayIndex(instant)] ?? "";
}

/**
 * Canonical single-date rendering: short weekday letter + geresh + `d.M` in
 * Asia/Jerusalem local time, e.g. "ד׳ 16.9" (CLAUDE.md hard rule 6; no date
 * is ever shown without its weekday, UX_FLOWS.md §1 / TODO.md B4).
 */
export function formatDayDate(instant: Date | string | number): string {
  return `${weekdayLabel(instant, "short")}${he.days.geresh} ${formatInTimeZone(instant, TZ, "d.M")}`;
}
