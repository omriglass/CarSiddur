import { he, tv } from "@/i18n/he";

import { barHeightFraction, percentTicks } from "../chartScale";
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
const AXIS_MAX = 100;
/** Show per-bar text under the chart only when it isn't going to wrap into a wall of numbers. */
const INLINE_TEXT_MAX_WEEKS = 12;
/** Few enough bars that five y-axis labels would crowd them — thin to 0/50/100 (`percentTicks`). */
const NARROW_WEEK_COUNT = 3;

/** `unmet / total` as a whole percent, or `null` when the week had no requests at all (no rate to show). */
function unmetPercent(week: WeeklyStat): number | null {
  return week.total > 0 ? Math.round((week.unmet / week.total) * 100) : null;
}

function weekDetail(week: WeeklyStat): string {
  const pct = unmetPercent(week);
  if (pct === null) return he.stats.weeklyNoRequests;
  return tv("stats.weeklyBarDetail", { unmet: String(week.unmet), total: String(week.total), pct: String(pct) });
}

/**
 * "Non-accepted requests by week" bar chart (UX_FLOWS.md §5.12): pure inline
 * SVG, one bar per week showing **unmet as a percentage of that week's total
 * requests** (`unmetPercent`) against a fixed 0–100 axis. A week with no
 * requests at all draws no bar (a faint dashed baseline) instead of a
 * misleading 0%. Provisional weeks (not yet archived) draw with a dashed
 * outline + lighter fill instead of the plain primary fill, called out once
 * in a legend note. Horizontally scrolls inside its own container — never
 * the page — when there are many weeks. Hidden entirely by the caller when
 * `weekly` is missing/empty.
 */
export function WeeklyUnmetChart({ weekly }: WeeklyUnmetChartProps) {
  if (weekly.length === 0) return null;

  const ticks = percentTicks(weekly.length <= NARROW_WEEK_COUNT);
  const showInlineValues = weekly.length <= INLINE_TEXT_MAX_WEEKS;
  const hasProvisional = weekly.some((week) => week.provisional);
  const plotWidth = weekly.length * (BAR_WIDTH + BAR_GAP) + BAR_GAP;
  const svgWidth = plotWidth + AXIS_GUTTER;
  const svgHeight = CHART_HEIGHT + BOTTOM_GUTTER;

  const srSummary = weekly.map((week) => `${formatDateDM(week.weekStart)}: ${weekDetail(week)}`).join("; ");

  return (
    <section className="space-y-2 rounded-md border p-4" aria-label={he.stats.weeklyUnmetTitle}>
      <div>
        <h2 className="text-sm font-medium text-foreground">{he.stats.weeklyUnmetTitle}</h2>
        <p className="text-xs text-muted-foreground">{he.stats.weeklyUnmetSubtitle}</p>
      </div>
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
            const y = CHART_HEIGHT - barHeightFraction(tick, AXIS_MAX) * CHART_HEIGHT;
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
                  {tick}%
                </text>
              </g>
            );
          })}
          {weekly.map((week, index) => {
            const pct = unmetPercent(week);
            const barHeight = pct === null ? 0 : barHeightFraction(pct, AXIS_MAX) * CHART_HEIGHT;
            const x = AXIS_GUTTER + BAR_GAP + index * (BAR_WIDTH + BAR_GAP);
            const y = CHART_HEIGHT - barHeight;
            const detail = weekDetail(week);
            return (
              <g key={week.weekStart} data-testid={`weekly-unmet-bar-${week.weekStart}`}>
                {pct === null ? (
                  <line
                    x1={x}
                    x2={x + BAR_WIDTH}
                    y1={CHART_HEIGHT - 1}
                    y2={CHART_HEIGHT - 1}
                    className="stroke-muted-foreground/50"
                    strokeWidth={2}
                    strokeDasharray="3 2"
                    data-testid={`weekly-unmet-baseline-${week.weekStart}`}
                  >
                    <title>{detail}</title>
                  </line>
                ) : (
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
                )}
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
          {weekly.map((week) => {
            const pct = unmetPercent(week);
            return (
              <li key={week.weekStart} data-testid={`weekly-unmet-row-${week.weekStart}`}>
                <span dir="ltr">{formatDateDM(week.weekStart)}</span>
                {": "}
                <span dir="ltr">{pct === null ? he.stats.weeklyNoRequests : `${pct}%`}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {hasProvisional ? (
        <p className="text-[11px] leading-snug text-muted-foreground/80">{he.stats.weeklyProvisional}</p>
      ) : null}
    </section>
  );
}
