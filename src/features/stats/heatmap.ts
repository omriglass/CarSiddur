import type { HourCell } from "./types";

/** REQ §13.167 (b): the three heatmap views of `department_stats.hourly`. */
export type HeatmapMode = "busy" | "starts" | "ends";
export const HEATMAP_MODES: readonly HeatmapMode[] = ["busy", "starts", "ends"];

/** The weekday columns (0=Sunday..6) plus the "weekly average" column. */
export type HeatmapColumn = number | "avg";
export const HEATMAP_COLUMNS: readonly HeatmapColumn[] = [0, 1, 2, 3, 4, 5, 6, "avg"];

/** Number of colour steps besides "nothing" (sequential, one hue, light → dark). */
export const HEATMAP_STEPS = 5;

export interface HeatmapGrid {
  hours: number[];
  /** value(column, hour) in the mode's unit: a 0..1 share for "busy", average rides for "starts"/"ends". */
  value: (column: HeatmapColumn, hour: number) => number;
  /** Top of the colour scale: 1 (the whole fleet) for "busy", else the largest value shown (average included). */
  max: number;
}

function cellValue(cell: HourCell, mode: HeatmapMode): number {
  return mode === "busy" ? cell.busyRate : mode === "starts" ? cell.starts : cell.ends;
}

/**
 * Builds the grid for one mode. The average column is the plain mean over the weekdays the range contains
 * (a weekday with no occurrence in a short range is left out, not counted as zero).
 */
export function buildHeatmap(cells: HourCell[], mode: HeatmapMode): HeatmapGrid {
  const byKey = new Map(cells.map((cell) => [`${cell.dow}:${cell.hour}`, cell]));
  const hours = [...new Set(cells.map((cell) => cell.hour))].sort((a, b) => a - b);
  const presentDows = [0, 1, 2, 3, 4, 5, 6].filter((dow) => cells.some((cell) => cell.dow === dow && cell.occurrences > 0));
  const value = (column: HeatmapColumn, hour: number): number => {
    if (column === "avg") {
      if (presentDows.length === 0) return 0;
      return presentDows.reduce((sum, dow) => sum + (byKey.get(`${dow}:${hour}`) ? cellValue(byKey.get(`${dow}:${hour}`)!, mode) : 0), 0) / presentDows.length;
    }
    const cell = byKey.get(`${column}:${hour}`);
    return cell ? cellValue(cell, mode) : 0;
  };
  let max = 0;
  if (mode === "busy") max = 1;
  else for (const hour of hours) for (const column of HEATMAP_COLUMNS) max = Math.max(max, value(column, hour));
  return { hours, value, max };
}

/** 0 = nothing at all; 1..HEATMAP_STEPS = how deep the blue is, relative to the grid's maximum. */
export function heatmapStep(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.ceil((value / max) * HEATMAP_STEPS));
}
