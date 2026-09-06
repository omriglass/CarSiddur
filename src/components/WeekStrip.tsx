import { datesOfWeek, todayInJerusalem } from "@/components/DateField";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

export interface WeekStripDayCounts {
  rides: number;
  unmet: number;
}

interface WeekStripProps {
  /** Sunday of the week, `yyyy-MM-dd`. */
  weekStart: string;
  /** Per-day ride/unmet counts, in Sun→Sat order, for the heat bars (UX_FLOWS.md §4.2). */
  counts?: readonly WeekStripDayCounts[];
  selected: string;
  onSelect: (date: string) => void;
}

/** True when `date` (`yyyy-MM-dd`) is today in Asia/Jerusalem. */
export function isToday(date: string, today = todayInJerusalem()): boolean {
  return date === today;
}

/**
 * Sun–Sat week selector with a today marker (component inventory
 * `WeekStrip`): thin heat bars above the day chips when `counts` is given
 * (the board's per-day orientation strip), otherwise plain day chips.
 */
export function WeekStrip({ weekStart, counts, selected, onSelect }: WeekStripProps) {
  const dates = datesOfWeek(weekStart);
  const maxCount = counts ? Math.max(1, ...counts.map((c) => c.rides)) : 1;

  return (
    <div className="flex gap-1" role="radiogroup" aria-label={he.field.day}>
      {dates.map((date, index) => {
        const dayCounts = counts?.[index];
        const isSelected = date === selected;
        const today = isToday(date);
        return (
          <button
            key={date}
            type="button"
            role="radio"
            aria-checked={isSelected}
            className={cn(
              "flex min-h-11 min-w-11 flex-1 flex-col items-center justify-end gap-0.5 rounded-md border px-1 pb-1 pt-2 text-xs",
              isSelected ? "border-primary bg-primary/10" : "border-input",
            )}
            onClick={() => onSelect(date)}
          >
            {dayCounts ? (
              <span
                className="w-full rounded-sm bg-primary/40"
                style={{ height: `${Math.max(4, (dayCounts.rides / maxCount) * 20)}px` }}
                aria-hidden="true"
              />
            ) : null}
            <span className="flex items-center gap-1">
              {he.days.short[index]}
              {today ? (
                <span
                  className="size-1.5 rounded-full bg-primary"
                  aria-label={he.weekStrip.today}
                  title={he.weekStrip.today}
                />
              ) : null}
            </span>
            {dayCounts && dayCounts.unmet > 0 ? (
              <span className="text-[10px] text-destructive" dir="ltr">
                {dayCounts.unmet}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
