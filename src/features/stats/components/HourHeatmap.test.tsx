import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import type { HourCell } from "../types";
import { HourHeatmap } from "./HourHeatmap";

const cells: HourCell[] = [0, 1, 2, 3, 4, 5, 6].flatMap((dow) =>
  Array.from({ length: 16 }, (_, i) => ({ dow, hour: 6 + i, occurrences: 1, busyRate: dow === 0 && i === 1 ? 1 : 0, starts: dow === 0 && i === 1 ? 2 : 0, ends: 0 })),
);

describe("HourHeatmap", () => {
  it("draws 16 hours × 7 days + the weekly average", () => {
    render(<HourHeatmap cells={cells} />);
    expect(screen.getAllByTestId(/^stats-heatmap-cell-/)).toHaveLength(16 * 8);
    expect(screen.getByText(he.stats.heatmap.average)).toBeInTheDocument();
    expect(screen.getByTestId("stats-heatmap-cell-0-7")).toHaveAttribute("data-step", "5");
    expect(screen.getByTestId("stats-heatmap-cell-1-7")).toHaveAttribute("data-step", "0");
    // 1/7 of the fleet on average at 07:00 → a light step, never empty.
    expect(Number(screen.getByTestId("stats-heatmap-cell-avg-7").getAttribute("data-step"))).toBeGreaterThan(0);
  });

  it("switches mode and reads a cell out", () => {
    render(<HourHeatmap cells={cells} />);
    fireEvent.click(screen.getByTestId("stats-heatmap-mode-starts"));
    fireEvent.click(screen.getByTestId("stats-heatmap-cell-0-7"));
    expect(screen.getByTestId("stats-heatmap-readout")).toHaveTextContent("07:00");
    expect(screen.getByTestId("stats-heatmap-readout")).toHaveTextContent(he.stats.heatmap.units.starts);
  });
});
