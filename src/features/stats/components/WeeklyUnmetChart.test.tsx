import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import type { WeeklyStat } from "../types";
import { WeeklyUnmetChart } from "./WeeklyUnmetChart";

const weekly: WeeklyStat[] = [
  { weekStart: "2026-08-02", total: 40, granted: 35, unmet: 3, cancelled: 2, rides: 33, provisional: false },
  { weekStart: "2026-08-09", total: 12, granted: 10, unmet: 2, cancelled: 0, rides: 9, provisional: true },
];

describe("WeeklyUnmetChart", () => {
  it("renders one bar and one inline row per week", () => {
    render(<WeeklyUnmetChart weekly={weekly} />);
    expect(screen.getByTestId("weekly-unmet-bar-2026-08-02")).toBeInTheDocument();
    expect(screen.getByTestId("weekly-unmet-bar-2026-08-09")).toBeInTheDocument();
    expect(screen.getByTestId("weekly-unmet-row-2026-08-02")).toHaveTextContent("3/40");
    expect(screen.getByTestId("weekly-unmet-row-2026-08-09")).toHaveTextContent("2/12");
  });

  it("shows the provisional-weeks legend note only when a week is provisional", () => {
    render(<WeeklyUnmetChart weekly={weekly} />);
    expect(screen.getByText(he.stats.weeklyProvisional)).toBeInTheDocument();
  });

  it("hides the provisional note when no week is provisional", () => {
    const allFinal = weekly.map((week) => ({ ...week, provisional: false }));
    render(<WeeklyUnmetChart weekly={allFinal} />);
    expect(screen.queryByText(he.stats.weeklyProvisional)).not.toBeInTheDocument();
  });

  it("carries every week's values in a screen-reader summary", () => {
    render(<WeeklyUnmetChart weekly={weekly} />);
    const summary = screen.getByTestId("weekly-unmet-sr-summary");
    expect(summary).toHaveTextContent("02/08");
    expect(summary).toHaveTextContent("09/08");
  });

  it("hides per-bar inline text when there are many weeks", () => {
    const many: WeeklyStat[] = Array.from({ length: 13 }, (_, i) => ({
      weekStart: `2026-01-${String(i + 1).padStart(2, "0")}`,
      total: 10,
      granted: 8,
      unmet: 2,
      cancelled: 0,
      rides: 8,
      provisional: false,
    }));
    render(<WeeklyUnmetChart weekly={many} />);
    expect(screen.queryByTestId("weekly-unmet-inline-values")).not.toBeInTheDocument();
  });

  it("renders nothing for empty weekly data", () => {
    const { container } = render(<WeeklyUnmetChart weekly={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
