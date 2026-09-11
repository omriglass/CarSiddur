import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { weekdayLabel } from "@/lib/dayLabels";
import { TZ } from "@/lib/time";

/**
 * Short label for a `yyyy-MM-dd` day key, e.g. `"א 14.9"` — used in the quick-request
 * header (`RequestForm.tsx`). Asia/Jerusalem-aware (CLAUDE.md hard rule 6): the day key is
 * anchored to Jerusalem midnight before deriving the weekday letter and the `dd.MM` date,
 * instead of parsing it as an unzoned device-local `Date` (`parseISO` + `getDay`).
 */
export function dayLabel(dateStr: string): string {
  const instant = fromZonedTime(`${dateStr}T00:00:00`, TZ);
  return `${weekdayLabel(instant, "short")} ${formatInTimeZone(instant, TZ, "dd.MM")}`;
}
