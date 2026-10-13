import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";
import { calendarCells, todayInJerusalem, weekdayOfDate } from "./dateFieldDates";

interface DateFieldProps {
  /**
   * First selectable day, `yyyy-MM-dd` — the Sunday of the target week for the ordinary day picker. Any
   * other weekday is fine: the days before it in its week show greyed, so columns are always Sunday..Saturday.
   */
  weekStart: string;
  value: string;
  onChange: (date: string) => void;
  /**
   * Consecutive selectable days, starting at `weekStart`. Default 7 (one week — the ordinary
   * departure-day picker). A multi-day request's own return-day picker (UX_FLOWS.md §3.4,
   * REQ §13.77) passes a larger count (e.g. 14) so a return day in the *following* week is
   * reachable without a separate component; one row per calendar week.
   */
  dayCount?: number;
  /** Overrides the radiogroup's `aria-label` (default `he.field.day`) — set this when two `DateField`s render on the same screen (e.g. a departure day and a later return day) so assistive tech can tell them apart. */
  ariaLabel?: string;
  /** react-hook-form field name, for `useScrollToFirstError` to find this control on an invalid submit. */
  dataField?: string;
  /**
   * A multi-day return picker: the departure day. Every day from it up to the chosen `value` is shaded a lighter
   * primary, so the span reads "all days from … to …" (owner 2026-10-13) — the departure day too, though it is not choosable here.
   */
  rangeStart?: string;
}

/**
 * Week-aware day picker with Hebrew day names (component inventory
 * `DateField`; UX_FLOWS.md §3.4 "יום א ב [ג] ד ה ו ש — day chips of target
 * week"). Distinct from `WeekStrip` (week-to-week navigation with heat
 * bars): this picks one day *within* an already-chosen week (or, with
 * `dayCount` extended, one of the next several weeks — see above).
 */
export function DateField({ weekStart, value, onChange, dayCount = 7, ariaLabel, dataField, rangeStart }: DateFieldProps) {
  const cells = calendarCells(weekStart, dayCount);
  const today = todayInJerusalem();
  // More than one row: show day.month so the date is unambiguous (R9U5).
  const multiWeek = cells.length > 7;

  return (
    <div
      className="inline-grid grid-cols-7 gap-1"
      role="radiogroup"
      aria-label={ariaLabel ?? he.field.day}
      data-field={dataField}
    >
      {cells.map(({ date, selectable }) => {
        const isSelected = selectable && date === value;
        // yyyy-MM-dd compares as text.
        const inRange = !!rangeStart && value > rangeStart && date >= rangeStart && date < value;
        const isToday = date === today;
        const dayNumber = date.slice(-2);
        const label = (
          <>
            <span>{he.days.short[weekdayOfDate(date)]}</span>
            <span className="text-[10px] tabular-nums" dir="ltr">
              {multiWeek ? `${Number(dayNumber)}.${Number(date.slice(5, 7))}` : dayNumber}
            </span>
          </>
        );
        if (!selectable) {
          return (
            <div
              key={date}
              aria-hidden="true"
              data-in-range={inRange || undefined}
              className={cn(
                "flex h-11 min-w-11 flex-col items-center justify-center rounded-md border text-sm",
                inRange ? "border-primary/40 bg-primary/20 text-primary" : "border-dashed text-muted-foreground opacity-50",
              )}
            >
              {label}
            </div>
          );
        }
        return (
          <button
            key={date}
            type="button"
            role="radio"
            aria-checked={isSelected}
            data-in-range={inRange || undefined}
            className={cn(
              "flex h-11 min-w-11 flex-col items-center justify-center rounded-md border text-sm",
              isSelected ? "border-primary bg-primary text-primary-foreground" : inRange ? "border-primary/40 bg-primary/20 text-primary" : "border-input",
              isToday && !isSelected && "border-primary",
            )}
            onClick={() => onChange(date)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
