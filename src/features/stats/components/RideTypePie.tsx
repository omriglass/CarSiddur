import { rideTypeColorClasses } from "@/lib/rideTypeColors";
import { he, tv } from "@/i18n/he";

import { formatDecimal } from "../format";
import { pieSegments } from "../pieMath";

import type { RideTypeStat } from "../types";

interface RideTypePieProps {
  data: RideTypeStat[];
}

const SIZE = 120;
const STROKE = 22;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Ride-type donut (UX_FLOWS.md §5.12 "Ride-type pie"): pure inline SVG
 * (`stroke-dasharray` arcs on a shared circle, no chart library), colored
 * via `src/lib/rideTypeColors.ts` so the pie matches the board legend. The
 * SVG itself is `aria-hidden`; the legend list below/beside it carries every
 * value, plus a hidden text summary for screen readers.
 */
export function RideTypePie({ data }: RideTypePieProps) {
  const totalRides = data.reduce((sum, row) => sum + row.rides, 0);
  const segments = pieSegments(data.map((row) => row.rides));

  if (data.length === 0 || totalRides <= 0) {
    return (
      <section className="space-y-2 rounded-md border p-4" aria-label={he.stats.rideTypePie.title}>
        <h2 className="text-sm font-medium text-foreground">{he.stats.rideTypePie.title}</h2>
        <p className="text-xs text-muted-foreground" data-testid="stats-ridetype-empty">
          {he.stats.rideTypePie.empty}
        </p>
      </section>
    );
  }

  const srSummary = data
    .map((row, index) =>
      tv("stats.rideTypePie.srSummaryItem", {
        name: row.name ?? he.stats.otherRideType,
        rides: String(row.rides),
        hours: formatDecimal(row.hours),
        percent: formatDecimal((segments[index]?.fraction ?? 0) * 100, 0),
      }),
    )
    .join("; ");

  return (
    <section className="space-y-4 rounded-md border p-4" aria-label={he.stats.rideTypePie.title}>
      <h2 className="text-sm font-medium text-foreground">{he.stats.rideTypePie.title}</h2>
      <p className="sr-only" data-testid="stats-ridetype-sr-summary">
        {srSummary}
      </p>
      <div className="flex flex-wrap items-center gap-6">
        <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true" className="-rotate-90">
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE}
              className="text-muted"
            />
            {data.map((row, index) => {
              const segment = segments[index];
              if (!segment || segment.fraction <= 0) return null;
              const dash = segment.fraction * CIRCUMFERENCE;
              return (
                <circle
                  key={row.rideTypeId ?? row.code}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={RADIUS}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={STROKE}
                  strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                  strokeDashoffset={-(segment.start * CIRCUMFERENCE)}
                  className={rideTypeColorClasses(row.code).text}
                />
              );
            })}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span dir="ltr" className="text-lg font-semibold text-foreground">
              {totalRides}
            </span>
            <span className="text-[10px] text-muted-foreground">{he.stats.rideTypePie.centerUnit}</span>
          </div>
        </div>
        <ul className="min-w-40 flex-1 space-y-1.5">
          {data.map((row, index) => {
            const percent = (segments[index]?.fraction ?? 0) * 100;
            return (
              <li
                key={row.rideTypeId ?? row.code}
                className="flex items-center gap-2 text-xs"
                data-testid={`stats-ridetype-row-${row.code}`}
                title={`${formatDecimal(row.hours)} ${he.stats.rideTypePie.hoursUnit}`}
              >
                <span
                  className={`size-2.5 shrink-0 rounded-full ${rideTypeColorClasses(row.code).dot}`}
                  aria-hidden="true"
                />
                <span className="flex-1 truncate text-foreground">{row.name ?? he.stats.otherRideType}</span>
                <span className="shrink-0 text-muted-foreground" dir="ltr">
                  {row.rides} ({formatDecimal(percent, 0)}%)
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
