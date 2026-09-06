import { addDays, format, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

import { he } from "@/i18n/he";
import { TZ } from "@/lib/time";
import { cn } from "@/lib/utils";

/** The 7 calendar dates (`yyyy-MM-dd`) of the week starting `weekStart` (a Sunday). */
export function datesOfWeek(weekStart: string): string[] {
  const start = parseISO(weekStart);
  return Array.from({ length: 7 }, (_, i) => format(addDays(start, i), "yyyy-MM-dd"));
}

/** Asia/Jerusalem "today" as `yyyy-MM-dd` (hard rule 6: never raw device time). */
export function todayInJerusalem(): string {
  return formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
}

/** `"14–20.9"` — the compact week-range label used in headers/switchers (UX_FLOWS.md §3.3). */
export function formatWeekRangeLabel(weekStart: string): string {
  const start = parseISO(weekStart);
  const end = addDays(start, 6);
  return `${format(start, "d")}–${format(end, "d.M")}`;
}

interface DateFieldProps {
  /** Sunday of the target week, `yyyy-MM-dd`. */
  weekStart: string;
  value: string;
  onChange: (date: string) => void;
}

/**
 * Week-aware day picker with Hebrew day names (component inventory
 * `DateField`; UX_FLOWS.md §3.4 "יום א ב [ג] ד ה ו ש — day chips of target
 * week"). Distinct from `WeekStrip` (week-to-week navigation with heat
 * bars): this picks one day *within* an already-chosen week.
 */
export function DateField({ weekStart, value, onChange }: DateFieldProps) {
  const dates = datesOfWeek(weekStart);
  const today = todayInJerusalem();

  return (
    <div className="flex gap-1" role="radiogroup" aria-label={he.field.day}>
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
            <span>{he.days.short[index]}</span>
            <span className="text-[10px] tabular-nums" dir="ltr">
              {dayNumber}
            </span>
          </button>
        );
      })}
    </div>
  );
}
