import { addDays, parseISO } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

import { weekdayLabel } from "@/lib/dayLabels";
import { TZ } from "@/lib/time";

/**
 * `department_stats`'s `byWeekday[].dow` is a bare 0 (Sunday) .. 6 (Saturday)
 * index with no associated calendar date. This anchors it to a known Sunday
 * and reuses `weekdayLabel` (never hand-indexing `he.days.short`, CLAUDE.md
 * Conventions) — the arithmetic happens entirely on the Asia/Jerusalem-zoned
 * representation (`toZonedTime` → `addDays` → `fromZonedTime`), the same
 * DST-safe recipe `weekStartFor` uses (`src/lib/time.ts`), so the mapping
 * never depends on the runtime's own time zone.
 */
const ANCHOR_SUNDAY_JERUSALEM_MIDNIGHT = fromZonedTime(parseISO("2024-01-07"), TZ);

/** Short Hebrew weekday label ("א", "ב", …) for a bare `dow` (0=Sunday..6=Saturday) index. */
export function weekdayShortLabelForDow(dow: number): string {
  const zonedAnchor = toZonedTime(ANCHOR_SUNDAY_JERUSALEM_MIDNIGHT, TZ);
  const zonedDay = addDays(zonedAnchor, dow);
  return weekdayLabel(fromZonedTime(zonedDay, TZ), "short");
}
