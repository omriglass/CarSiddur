import { describe, expect, it } from "vitest";

import { buildHeatmap, heatmapStep } from "./heatmap";
import type { HourCell } from "./types";

function cell(dow: number, hour: number, busyRate: number, starts = 0, ends = 0, occurrences = 1): HourCell {
  return { dow, hour, occurrences, busyRate, starts, ends };
}

describe("heatmap grid", () => {
  const cells = [0, 1, 2, 3, 4, 5, 6].flatMap((dow) => [cell(dow, 7, dow === 0 ? 0.8 : 0.1, dow === 0 ? 3 : 1), cell(dow, 8, 0, 0, dow === 1 ? 2 : 0)]);

  it("reads each weekday and averages the week", () => {
    const busy = buildHeatmap(cells, "busy");
    expect(busy.hours).toEqual([7, 8]);
    expect(busy.value(0, 7)).toBe(0.8);
    expect(busy.value("avg", 7)).toBeCloseTo((0.8 + 6 * 0.1) / 7);
    expect(busy.max).toBe(1);
  });

  it("scales start/end views to their own maximum", () => {
    expect(buildHeatmap(cells, "starts").max).toBe(3);
    expect(buildHeatmap(cells, "ends").value("avg", 8)).toBeCloseTo(2 / 7);
  });

  it("leaves weekdays the range does not contain out of the average", () => {
    const short = [cell(0, 9, 0.5), cell(1, 9, 0.3), ...[2, 3, 4, 5, 6].map((dow) => cell(dow, 9, 0, 0, 0, 0))];
    expect(buildHeatmap(short, "busy").value("avg", 9)).toBeCloseTo(0.4);
  });

  it("maps values to colour steps, empty stays empty", () => {
    expect(heatmapStep(0, 1)).toBe(0);
    expect(heatmapStep(0.01, 1)).toBe(1);
    expect(heatmapStep(0.5, 1)).toBe(3);
    expect(heatmapStep(1, 1)).toBe(5);
    expect(heatmapStep(2, 0)).toBe(0);
  });
});
