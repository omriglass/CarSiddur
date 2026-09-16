import { dateKey } from "@/lib/time";

/**
 * `/my` shows only what lies ahead (REQ §13 item 91, owner 2026-09-16, E3): "a request whose
 * day has passed is not shown; it is history, not a to-do." True when `day` falls on `now`'s
 * Asia/Jerusalem calendar day or later — a plain string comparison of `dateKey`s (both
 * `yyyy-MM-dd`, so lexicographic order is calendar order).
 */
export function isTodayOrLater(day: Date | string | number, now: Date | string | number = new Date()): boolean {
  return dateKey(day) >= dateKey(now);
}
