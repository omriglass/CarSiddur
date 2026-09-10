import { weekdayShortLabelForDow } from "../dowLabel";
import { formatDecimal } from "../format";

import { he } from "@/i18n/he";

import type { WeekdayStat } from "../types";

interface WeekdayBarListProps {
  days: WeekdayStat[];
}

/**
 * "Busiest days" horizontal bar list (UX_FLOWS.md §5.12): pure CSS width
 * bars, no chart library. Bars are `aria-hidden`; the hours/rides text next
 * to each row is the accessible value.
 */
export function WeekdayBarList({ days }: WeekdayBarListProps) {
  const sorted = [...days].sort((a, b) => a.dow - b.dow);
  const maxRate = Math.max(0, ...sorted.map((day) => day.utilizationRate));
  const busiestDow = maxRate > 0 ? sorted.find((day) => day.utilizationRate === maxRate)?.dow : undefined;

  return (
    <section className="space-y-3 rounded-md border p-4" aria-label={he.stats.busiestDays.title}>
      <h2 className="text-sm font-medium text-foreground">{he.stats.busiestDays.title}</h2>
      <ul className="space-y-2">
        {sorted.map((day) => {
          const widthPct = maxRate > 0 ? Math.round((day.utilizationRate / maxRate) * 100) : 0;
          return (
            <li key={day.dow} className="flex items-center gap-3" data-testid={`stats-weekday-row-${day.dow}`}>
              <span className="w-5 shrink-0 text-sm text-muted-foreground">{weekdayShortLabelForDow(day.dow)}</span>
              <span className="relative h-3 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span className="absolute inset-y-0 start-0 rounded-full bg-primary" style={{ width: `${widthPct}%` }} />
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <span dir="ltr">{formatDecimal(day.avgActiveHours)}</span> {he.stats.busiestDays.hoursUnit}
                {" · "}
                <span dir="ltr">{formatDecimal(day.avgRides)}</span> {he.stats.busiestDays.ridesUnit}
              </span>
              {day.dow === busiestDow ? (
                <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                  {he.stats.busiestDays.busiestBadge}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
