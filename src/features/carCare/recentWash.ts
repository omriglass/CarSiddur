import { formatInTimeZone } from "date-fns-tz";

import { TZ, weekStartFor } from "@/lib/time";

/** Start (instant) of the Sunday of last week, Asia/Jerusalem: a car washed on/after it is "recently washed" (REQ §13.185 f). */
export function recentWashSince(now: Date): Date {
  const thisWeek = weekStartFor(now);
  // 3.5 days back from this Sunday 00:00 lands mid-week of the previous week whatever the DST shift.
  return weekStartFor(new Date(thisWeek.getTime() - 3.5 * 24 * 3600 * 1000));
}

/** Car ids whose latest wash (`createdAt` ISO strings) is on or after last week's Sunday. */
export function recentlyWashedCarIds(
  events: readonly { car_id: string; created_at: string }[],
  now: Date,
): Set<string> {
  const since = recentWashSince(now).getTime();
  return new Set(events.filter((e) => new Date(e.created_at).getTime() >= since).map((e) => e.car_id));
}

/** Sunday date key (yyyy-MM-dd) used by the query to bound the read. */
export function recentWashSinceKey(now: Date): string {
  return formatInTimeZone(recentWashSince(now), TZ, "yyyy-MM-dd");
}
