import { he, tv } from "@/i18n/he";

import { barHeightFraction, niceYAxisTicks } from "../chartScale";
import { formatDateDM } from "../format";

import type { WeeklyStat } from "../types";

interface WeeklyUnmetChartProps {
  weekly: WeeklyStat[];
}

const CHART_HEIGHT = 140;
const BAR_WIDTH = 28;
const BAR_GAP = 14;
const AXIS_GUTTER = 28;
const BOTTOM_GUTTER = 20;
/** Show per-bar text under the chart only when it isn't going to wrap into a wall of numbers. */
const INLINE_TEXT_MAX_WEEKS = 12;

/**
 * "Non-accepted requests by week" bar chart (UX_FLOWS.md §5.12): pure inline
 * SVG, one bar per `weekly[].unmet`. Provisional weeks (not yet archived)
 * draw with a dashed outline + lighter fill instead of the plain primary
 * fill, called out once in a legend note. Horizontally scrolls inside its
 * own container — never the page — when there are many weeks. Hidden
 * entirely by the caller when `weekly` is missing/empty.
 */
export function WeeklyUnmetChart({ weekly }: WeeklyUnmetChartProps) {
  if (weekly.length === 0) return null;

  const maxUnmet = Math.max(0, ...weekly.map((week) => week.unmet));
  const ticks = niceYAxisTicks(maxUnmet);
  const axisMax = ticks.at(-1) ?? 0;
  const showInlineValues = weekly.length <= INLINE_TEXT_MAX_WEEKS;
  const hasProvisional = weekly.some((week) => week.provisional);
  const plotWidth = weekly.length * (BAR_WIDTH + BAR_GAP) + BAR_GAP;
  const svgWidth = plotWidth + AXIS_GUTTER;
  const svgHeight = CHART_HEIGHT + BOTTOM_GUTTER;

  const srSummary = weekly
    .map(
      (week) =>
        `${formatDateDM(week.weekStart)}: ${tv("stats.weeklyBarDetail", {
          unmet: String(week.unmet),
          total: String(week.total),
        })}`,
    )
    .join("; ");

  return (
    <section className="space-y-2 rounded-md border p-4" aria-label={he.stats.weeklyUnmetTitle}>
      <h2 className="text-sm font-medium text-foreground">{he.stats.weeklyUnmetTitle}</h2>
      <p className="sr-only" data-testid="weekly-unmet-sr-summary">
        {srSummary}
      </p>
      <div className="overflow-x-auto" data-testid="weekly-unmet-scroll">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          width={Math.max(svgWidth, 240)}
          height={svgHeight}
          aria-hidden="true"
          className="max-w-none"
        >
          {ticks.map((tick) => {
            const y = CHART_HEIGHT - barHeightFraction(tick, axisMax) * CHART_HEIGHT;
            return (
              <g key={tick}>
                <line
                  x1={AXIS_GUTTER}
                  x2={svgWidth}
                  y1={y}
                  y2={y}
                  className="stroke-border"
                  strokeWidth={1}
                />
                <text x={AXIS_GUTTER - 4} y={y + 3} textAnchor="end" className="fill-muted-foreground text-[8px]">
                  {tick}
                </text>
              </g>
            );
          })}
          {weekly.map((week, index) => {
            const barHeight = barHeightFraction(week.unmet, axisMax) * CHART_HEIGHT;
            const x = AXIS_GUTTER + BAR_GAP + index * (BAR_WIDTH + BAR_GAP);
            const y = CHART_HEIGHT - barHeight;
            const detail = tv("stats.weeklyBarDetail", { unmet: String(week.unmet), total: String(week.total) });
            return (
              <g key={week.weekStart} data-testid={`weekly-unmet-bar-${week.weekStart}`}>
                <rect
                  x={x}
                  y={y}
                  width={BAR_WIDTH}
                  height={Math.max(barHeight, 1)}
                  rx={2}
                  className={week.provisional ? "fill-primary/30 stroke-primary" : "fill-primary"}
                  strokeWidth={week.provisional ? 1.5 : 0}
                  strokeDasharray={week.provisional ? "3 2" : undefined}
                >
                  <title>{detail}</title>
                </rect>
                <text
                  x={x + BAR_WIDTH / 2}
                  y={CHART_HEIGHT + 14}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[8px]"
                >
                  {formatDateDM(week.weekStart)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {showInlineValues ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="weekly-unmet-inline-values">
          {weekly.map((week) => (
            <li key={week.weekStart} data-testid={`weekly-unmet-row-${week.weekStart}`}>
              <span dir="ltr">{formatDateDM(week.weekStart)}</span>
              {": "}
              <span dir="ltr">
                {week.unmet}/{week.total}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {hasProvisional ? (
        <p className="text-[11px] leading-snug text-muted-foreground/80">{he.stats.weeklyProvisional}</p>
      ) : null}
    </section>
  );
}
