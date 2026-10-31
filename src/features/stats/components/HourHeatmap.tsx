import { useState } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { he, tv } from "@/i18n/he";

import { weekdayShortLabelForDow } from "../dowLabel";
import { formatDecimal, formatPercent } from "../format";
import { buildHeatmap, HEATMAP_COLUMNS, HEATMAP_MODES, heatmapStep, type HeatmapColumn, type HeatmapMode } from "../heatmap";
import type { HourCell } from "../types";

/** Alpha per colour step on `--primary` (step 0 = an empty, muted cell): one hue, light → dark. */
const STEP_ALPHA = [0, 0.14, 0.3, 0.48, 0.7, 0.95];

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatValue(value: number, mode: HeatmapMode): string {
  return mode === "busy" ? formatPercent(value) : formatDecimal(value, 1);
}

function columnLabel(column: HeatmapColumn): string {
  return column === "avg" ? he.stats.heatmap.average : weekdayShortLabelForDow(column);
}

/**
 * REQ §13.167 (b): weekday × hour heatmap (06:00–22:00) of the shared fleet — how busy each hour is
 * (% of the cars out), or when rides start / end (average rides per such day). The eighth column is
 * the weekly average, set apart by a gap and a frame but on the same colour scale as the days.
 * Plain CSS grid, no chart library; the table semantics double as the screen-reader view.
 */
export function HourHeatmap({ cells }: { cells: HourCell[] }) {
  const [mode, setMode] = useState<HeatmapMode>("busy");
  const [focus, setFocus] = useState<{ column: HeatmapColumn; hour: number } | null>(null);
  const grid = buildHeatmap(cells, mode);
  if (grid.hours.length === 0) return null;

  const readout = focus
    ? tv("stats.heatmap.readout", {
        day: columnLabel(focus.column),
        hour: hourLabel(focus.hour),
        value: formatValue(grid.value(focus.column, focus.hour), mode),
        unit: he.stats.heatmap.units[mode],
      })
    : he.stats.heatmap.help[mode];

  return (
    <section className="space-y-3 rounded-md border p-4" aria-label={he.stats.heatmap.title} data-testid="stats-heatmap">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">{he.stats.heatmap.title}</h2>
        <ToggleGroup type="single" value={mode} onValueChange={(next) => next && setMode(next as HeatmapMode)} className="flex-wrap justify-start">
          {HEATMAP_MODES.map((m) => (
            <ToggleGroupItem key={m} value={m} className="h-8 px-2.5 text-xs" data-testid={`stats-heatmap-mode-${m}`}>
              {he.stats.heatmap.modes[m]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <p className="min-h-[2.5em] text-xs text-muted-foreground" aria-live="polite" data-testid="stats-heatmap-readout">{readout}</p>
      <table className="w-full table-fixed border-separate border-spacing-0.5 text-[11px]" onMouseLeave={() => setFocus(null)}>
        <thead>
          <tr>
            <th className="w-11" scope="col"><span className="sr-only">{he.stats.heatmap.hourColumn}</span></th>
            {HEATMAP_COLUMNS.map((column) => (
              <th key={column} scope="col" className={column === "avg" ? "ps-2 font-semibold text-foreground" : "font-normal text-muted-foreground"}>
                {columnLabel(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.hours.map((hour) => (
            <tr key={hour}>
              <th scope="row" className="pe-1 text-start font-normal text-muted-foreground" dir="ltr">{hourLabel(hour)}</th>
              {HEATMAP_COLUMNS.map((column) => {
                const value = grid.value(column, hour);
                const step = heatmapStep(value, grid.max);
                const label = `${columnLabel(column)} ${hourLabel(hour)}: ${formatValue(value, mode)} ${he.stats.heatmap.units[mode]}`;
                return (
                  <td key={column} className={column === "avg" ? "ps-2" : undefined}>
                    <button
                      type="button"
                      className={`block h-5 w-full rounded-[3px] ${step === 0 ? "bg-muted" : ""} ${column === "avg" ? "ring-1 ring-foreground/25" : ""} focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring`}
                      style={step === 0 ? undefined : { backgroundColor: `hsl(var(--primary) / ${STEP_ALPHA[step]})` }}
                      aria-label={label}
                      title={label}
                      data-testid={`stats-heatmap-cell-${column}-${hour}`}
                      data-step={step}
                      onMouseEnter={() => setFocus({ column, hour })}
                      onFocus={() => setFocus({ column, hour })}
                      onClick={() => setFocus({ column, hour })}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground" aria-hidden="true">
        <span>{he.stats.heatmap.legendLow}</span>
        {STEP_ALPHA.map((alpha, step) => (
          <span key={step} className={`h-3 w-4 rounded-[2px] ${step === 0 ? "bg-muted" : ""}`} style={step === 0 ? undefined : { backgroundColor: `hsl(var(--primary) / ${alpha})` }} />
        ))}
        <span>{he.stats.heatmap.legendHigh}</span>
      </div>
    </section>
  );
}
