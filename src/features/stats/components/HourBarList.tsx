import { he } from "@/i18n/he";

import type { HourStat } from "../types";

interface HourBarListProps {
  hours: HourStat[];
}

/** "08:00"-style Jerusalem-hour label, `<span dir="ltr">`-ready (no formatting library needed for a bare integer hour). */
function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * S4 -- requests-per-hour histogram (owner request 2026-09-14, docs/TODO.md "S -- Statistics
 * group"): pure-CSS horizontal bar list, same approach as `WeekdayBarList` (no chart library).
 * Always receives all 24 hours from the RPC; the quiet 00:00-05:59 range is hidden when every
 * one of those hours is at zero (UX_FLOWS.md §5.12), rather than always eating six empty rows.
 */
export function HourBarList({ hours }: HourBarListProps) {
  const sorted = [...hours].sort((a, b) => a.hour - b.hour);
  const nightIsEmpty = sorted.filter((h) => h.hour < 6).every((h) => h.count === 0);
  const visible = nightIsEmpty ? sorted.filter((h) => h.hour >= 6) : sorted;
  const maxCount = Math.max(0, ...visible.map((h) => h.count));

  if (visible.length === 0) return null;

  return (
    <section className="space-y-3 rounded-md border p-4" aria-label={he.stats.requestsByHour.title}>
      <h2 className="text-sm font-medium text-foreground">{he.stats.requestsByHour.title}</h2>
      <ul className="space-y-1.5">
        {visible.map((row) => {
          const widthPct = maxCount > 0 ? Math.round((row.count / maxCount) * 100) : 0;
          return (
            <li key={row.hour} className="flex items-center gap-3" data-testid={`stats-hour-row-${row.hour}`}>
              <span className="w-12 shrink-0 text-xs text-muted-foreground" dir="ltr">
                {hourLabel(row.hour)}
              </span>
              <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span className="absolute inset-y-0 start-0 rounded-full bg-primary" style={{ width: `${widthPct}%` }} />
              </span>
              <span className="w-6 shrink-0 text-end text-xs text-muted-foreground" dir="ltr">
                {row.count}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
