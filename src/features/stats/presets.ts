import { addDays, format, parseISO, startOfYear, subMonths } from "date-fns";

/** The statistics screen's three quick date-range chips (owner spec, UX_FLOWS.md §5.12). */
export const STATS_PRESET_KEYS = ["last4Weeks", "last3Months", "thisYear"] as const;
export type StatsPresetKey = (typeof STATS_PRESET_KEYS)[number];

export interface StatsDateRange {
  from: string;
  to: string;
}

export const DEFAULT_STATS_PRESET: StatsPresetKey = "last4Weeks";

/**
 * Pure calendar-day arithmetic on `today` — a `yyyy-MM-dd` string the caller
 * already computed via `todayInJerusalem()` (`src/components/DateField.tsx`),
 * so this module never reads the clock or a device time zone itself
 * (CLAUDE.md hard rule 6). `to` is always `today`; only `from` varies.
 */
export function computePresetRange(preset: StatsPresetKey, today: string): StatsDateRange {
  const todayDate = parseISO(today);
  switch (preset) {
    case "last4Weeks":
      return { from: format(addDays(todayDate, -28), "yyyy-MM-dd"), to: today };
    case "last3Months":
      return { from: format(subMonths(todayDate, 3), "yyyy-MM-dd"), to: today };
    case "thisYear":
      return { from: format(startOfYear(todayDate), "yyyy-MM-dd"), to: today };
    default:
      return { from: today, to: today };
  }
}
