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
  it("renders the title's subtitle", () => {
    render(<WeeklyUnmetChart weekly={weekly} />);
    expect(screen.getByText(he.stats.weeklyUnmetSubtitle)).toBeInTheDocument();
  });

  it("renders one bar and one inline row per week, as a percentage of that week's total", () => {
    render(<WeeklyUnmetChart weekly={weekly} />);
    expect(screen.getByTestId("weekly-unmet-bar-2026-08-02")).toBeInTheDocument();
    expect(screen.getByTestId("weekly-unmet-bar-2026-08-09")).toBeInTheDocument();
    // 3/40 = 7.5% -> rounds to 8%; 2/12 = 16.67% -> rounds to 17%.
    expect(screen.getByTestId("weekly-unmet-row-2026-08-02")).toHaveTextContent("8%");
    expect(screen.getByTestId("weekly-unmet-row-2026-08-09")).toHaveTextContent("17%");
  });

  it("renders no bar, only a faint baseline dash, for a week with no requests at all", () => {
    const withEmptyWeek: WeeklyStat[] = [
      ...weekly,
      { weekStart: "2026-08-16", total: 0, granted: 0, unmet: 0, cancelled: 0, rides: 0, provisional: true },
    ];
    render(<WeeklyUnmetChart weekly={withEmptyWeek} />);
    expect(screen.getByTestId("weekly-unmet-baseline-2026-08-16")).toBeInTheDocument();
    expect(screen.getByTestId("weekly-unmet-row-2026-08-16")).toHaveTextContent("—");
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

  it("carries every week's values, including the percentage, in a screen-reader summary", () => {
    render(<WeeklyUnmetChart weekly={weekly} />);
    const summary = screen.getByTestId("weekly-unmet-sr-summary");
    expect(summary).toHaveTextContent("02/08");
    expect(summary).toHaveTextContent("09/08");
    expect(summary).toHaveTextContent("3 מתוך 40 (8%)");
    expect(summary).toHaveTextContent("2 מתוך 12 (17%)");
  });

  it("shows all five y-axis ticks for enough weeks, and thins to 0/50/100 for a handful", () => {
    const enoughWeeks: WeeklyStat[] = [
      ...weekly,
      { weekStart: "2026-08-16", total: 10, granted: 8, unmet: 2, cancelled: 0, rides: 8, provisional: false },
      { weekStart: "2026-08-23", total: 10, granted: 8, unmet: 2, cancelled: 0, rides: 8, provisional: false },
    ];
    const { unmount } = render(<WeeklyUnmetChart weekly={enoughWeeks} />);
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    unmount();

    const few = weekly.slice(0, 1);
    render(<WeeklyUnmetChart weekly={few} />);
    expect(screen.queryByText("25%")).not.toBeInTheDocument();
    expect(screen.queryByText("75%")).not.toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
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
