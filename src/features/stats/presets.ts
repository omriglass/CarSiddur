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
 *
 * `earliest` (`department_stats`'s earliest-data date, once known) clamps the
 * computed `from` upward so a preset never asks for a range starting before
 * the department has any data (owner feedback, UX_FLOWS.md §5.12).
 */
export function computePresetRange(
  preset: StatsPresetKey,
  today: string,
  earliest?: string | null,
): StatsDateRange {
  const todayDate = parseISO(today);
  const from = (() => {
    switch (preset) {
      case "last4Weeks":
        return format(addDays(todayDate, -28), "yyyy-MM-dd");
      case "last3Months":
        return format(subMonths(todayDate, 3), "yyyy-MM-dd");
      case "thisYear":
        return format(startOfYear(todayDate), "yyyy-MM-dd");
      default:
        return today;
    }
  })();
  return { from: earliest && earliest > from ? earliest : from, to: today };
}
