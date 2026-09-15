import { fromZonedTime } from "date-fns-tz";

import { formatDayDate } from "@/lib/dayLabels";
import { TZ } from "@/lib/time";

/**
 * Short label for a `yyyy-MM-dd` day key, e.g. `"ד׳ 16.9"` — used in the quick-request
 * header (`RequestForm.tsx`). Asia/Jerusalem-aware (CLAUDE.md hard rule 6): the day key is
 * anchored to Jerusalem midnight before deriving the canonical weekday+date label
 * (`formatDayDate`), instead of parsing it as an unzoned device-local `Date` (`parseISO` + `getDay`).
 */
export function dayLabel(dateStr: string): string {
  const instant = fromZonedTime(`${dateStr}T00:00:00`, TZ);
  return formatDayDate(instant);
}
