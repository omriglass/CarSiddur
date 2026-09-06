import { formatInTimeZone } from "date-fns-tz";

import { datesOfWeek } from "@/components/DateField";
import { TZ } from "@/lib/time";

/** One day's bucket for the phone `DayList` (UX_FLOWS.md §3.5): sticky day tabs, rides sorted by departure. */
export interface DayGroup<T> {
  /** `yyyy-MM-dd` */
  date: string;
  /** 0 (Sunday) .. 6 (Saturday), matching `he.days.short`/`DateField`. */
  dayIndex: number;
  items: T[];
}

/**
 * Buckets `items` into the 7 days of `weekStart`'s week (Asia/Jerusalem calendar
 * day), each sorted by `getStartsAt`. Items whose instant falls outside the
 * week (shouldn't happen for a well-formed siddur, but defensive) are dropped
 * silently rather than crashing the list.
 */
export function groupByDay<T>(
  items: readonly T[],
  weekStart: string,
  getStartsAt: (item: T) => string,
): DayGroup<T>[] {
  const dates = datesOfWeek(weekStart);
  const buckets: DayGroup<T>[] = dates.map((date, dayIndex) => ({ date, dayIndex, items: [] }));

  for (const item of items) {
    const day = formatInTimeZone(new Date(getStartsAt(item)), TZ, "yyyy-MM-dd");
    const index = dates.indexOf(day);
    const bucket = index >= 0 ? buckets[index] : undefined;
    bucket?.items.push(item);
  }

  for (const bucket of buckets) {
    bucket.items.sort((a, b) => new Date(getStartsAt(a)).getTime() - new Date(getStartsAt(b)).getTime());
  }

  return buckets;
}
