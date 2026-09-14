import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { HourStat } from "../types";
import { HourBarList } from "./HourBarList";

function makeHours(counts: Partial<Record<number, number>>): HourStat[] {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, count: counts[hour] ?? 0 }));
}

describe("HourBarList", () => {
  it("hides the 00:00-05:59 range when it is entirely empty", () => {
    render(<HourBarList hours={makeHours({ 8: 3, 14: 1 })} />);
    expect(screen.queryByTestId("stats-hour-row-0")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stats-hour-row-5")).not.toBeInTheDocument();
    expect(screen.getByTestId("stats-hour-row-6")).toBeInTheDocument();
    expect(screen.getByTestId("stats-hour-row-8")).toHaveTextContent("08:00");
    expect(screen.getByTestId("stats-hour-row-8")).toHaveTextContent("3");
  });

  it("shows every hour, including the night range, once any night hour has a count", () => {
    render(<HourBarList hours={makeHours({ 2: 1, 8: 3 })} />);
    expect(screen.getByTestId("stats-hour-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("stats-hour-row-2")).toHaveTextContent("1");
  });

  it("renders all 24 rows sorted by hour when nothing is empty", () => {
    render(<HourBarList hours={makeHours({ 0: 1, 23: 1 })} />);
    const rows = screen.getAllByTestId(/^stats-hour-row-/);
    expect(rows).toHaveLength(24);
  });
});
