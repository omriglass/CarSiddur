import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";
import { datesFrom, todayInJerusalem } from "./dateFieldDates";

interface DateFieldProps {
  /** Sunday of the target week, `yyyy-MM-dd`. */
  weekStart: string;
  value: string;
  onChange: (date: string) => void;
  /**
   * Consecutive days shown, starting at `weekStart`. Default 7 (one week — the ordinary
   * departure-day picker). A multi-day request's own return-day picker (UX_FLOWS.md §3.4,
   * REQ §13.77) passes a larger count (e.g. 14) so a return day in the *following* week is
   * reachable without a separate component; wraps to a second row past 7 days.
   */
  dayCount?: number;
  /** Overrides the radiogroup's `aria-label` (default `he.field.day`) — set this when two `DateField`s render on the same screen (e.g. a departure day and a later return day) so assistive tech can tell them apart. */
  ariaLabel?: string;
  /** react-hook-form field name, for `useScrollToFirstError` to find this control on an invalid submit. */
  dataField?: string;
}

/**
 * Week-aware day picker with Hebrew day names (component inventory
 * `DateField`; UX_FLOWS.md §3.4 "יום א ב [ג] ד ה ו ש — day chips of target
 * week"). Distinct from `WeekStrip` (week-to-week navigation with heat
 * bars): this picks one day *within* an already-chosen week (or, with
 * `dayCount` extended, one of the next several weeks — see above).
 */
export function DateField({ weekStart, value, onChange, dayCount = 7, ariaLabel, dataField }: DateFieldProps) {
  const dates = datesFrom(weekStart, dayCount);
  const today = todayInJerusalem();

  return (
    <div
      className={cn("flex gap-1", dayCount > 7 && "flex-wrap")}
      role="radiogroup"
      aria-label={ariaLabel ?? he.field.day}
      data-field={dataField}
    >
      {dates.map((date, index) => {
        const isSelected = date === value;
        const isToday = date === today;
        const dayNumber = date.slice(-2);
        return (
          <button
            key={date}
            type="button"
            role="radio"
            aria-checked={isSelected}
            className={cn(
              "flex h-11 min-w-11 flex-col items-center justify-center rounded-md border text-sm",
              isSelected ? "border-primary bg-primary text-primary-foreground" : "border-input",
              isToday && !isSelected && "border-primary",
            )}
            onClick={() => onChange(date)}
          >
            <span>{he.days.short[index % 7]}</span>
            <span className="text-[10px] tabular-nums" dir="ltr">
              {dayNumber}
            </span>
          </button>
        );
      })}
    </div>
  );
}
