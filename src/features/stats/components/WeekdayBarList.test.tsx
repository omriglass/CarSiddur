import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import type { WeekdayStat } from "../types";
import { WeekdayBarList } from "./WeekdayBarList";

const days: WeekdayStat[] = [
  { dow: 0, occurrences: 6, avgActiveHours: 2, avgRides: 3, utilizationRate: 0.1 },
  { dow: 1, occurrences: 6, avgActiveHours: 4.2, avgRides: 5.1, utilizationRate: 0.4 },
  { dow: 2, occurrences: 6, avgActiveHours: 1, avgRides: 1, utilizationRate: 0.05 },
  { dow: 3, occurrences: 6, avgActiveHours: 0, avgRides: 0, utilizationRate: 0 },
  { dow: 4, occurrences: 6, avgActiveHours: 0, avgRides: 0, utilizationRate: 0 },
  { dow: 5, occurrences: 6, avgActiveHours: 0, avgRides: 0, utilizationRate: 0 },
  { dow: 6, occurrences: 0, avgActiveHours: 0, avgRides: 0, utilizationRate: 0 },
];

describe("WeekdayBarList", () => {
  it("renders one row per weekday, Sunday first", () => {
    render(<WeekdayBarList days={[...days].reverse()} />);
    const rows = [0, 1, 2, 3, 4, 5, 6].map((dow) => screen.getByTestId(`stats-weekday-row-${dow}`));
    expect(rows).toHaveLength(7);
    expect(rows[0]).toHaveTextContent(he.days.short[0]!);
    expect(rows[6]).toHaveTextContent(he.days.short[6]!);
  });

  it("marks only the highest-utilization day as busiest", () => {
    render(<WeekdayBarList days={days} />);
    expect(screen.getByTestId("stats-weekday-row-1")).toHaveTextContent(he.stats.busiestDays.busiestBadge);
    expect(screen.getByTestId("stats-weekday-row-0")).not.toHaveTextContent(he.stats.busiestDays.busiestBadge);
  });

  it("shows no busiest badge when every day is at zero utilization", () => {
    const flat = days.map((day) => ({ ...day, utilizationRate: 0 }));
    render(<WeekdayBarList days={flat} />);
    expect(screen.queryByText(he.stats.busiestDays.busiestBadge)).not.toBeInTheDocument();
  });
});
