import { he } from "@/i18n/he";
import { weekdayIndex } from "@/lib/time";

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
