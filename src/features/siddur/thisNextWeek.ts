import { addDays, parseISO } from "date-fns";

import { dateKey, weekStartFor } from "@/lib/time";

import type { Week } from "./api";

export interface ThisNextWeekResolution<W> {
  /** `yyyy-MM-dd` Sunday of the week containing today, regardless of whether it is visible. */
  thisWeekStart: string;
  /** `yyyy-MM-dd` Sunday of the week right after `thisWeekStart`. */
  nextWeekStart: string;
  /** The matching entry from `weeks`, or `null` when it isn't visible (RLS / not yet opened). */
  thisWeek: W | null;
  nextWeek: W | null;
}

/**
 * Mobile siddur header title (UX_FLOWS.md member siddur "this week / next
 * week" switcher): resolves the two candidate weeks from today's date alone
 * — never from `weeks`' own contents — so a week missing from the
 * (RLS-filtered) list still renders as a disabled option with a real date
 * range instead of vanishing outright. Pure (`todayDateKey` is passed in,
 * never computed from `Date.now()` here) so it is unit-testable without
 * mocking the clock.
 */
export function resolveThisNextWeek<W extends Pick<Week, "week_start">>(
  weeks: readonly W[],
  todayDateKey: string,
): ThisNextWeekResolution<W> {
  const thisWeekStart = dateKey(weekStartFor(parseISO(todayDateKey)));
  const nextWeekStart = dateKey(addDays(parseISO(thisWeekStart), 7));
  return {
    thisWeekStart,
    nextWeekStart,
    thisWeek: weeks.find((w) => w.week_start === thisWeekStart) ?? null,
    nextWeek: weeks.find((w) => w.week_start === nextWeekStart) ?? null,
  };
}
