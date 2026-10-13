import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WeekGrid } from "./WeekGrid";

const cars = [{ id: "a", name: "Car A" }];

describe("WeekGrid now quarter (owner 2026-10-13)", () => {
  it("tints and labels the current quarter inside its hour cell", () => {
    render(<WeekGrid cars={cars} rides={[]} dayStartMinutes={0} nowQuarterMinutes={7 * 60 + 45} />);
    const band = screen.getByTestId("week-grid-now-quarter");
    expect(band).toHaveTextContent("07:45");
    expect(band.style.top).toBe("75%");
    expect(band.parentElement).toHaveTextContent(/^07:00/);
  });

  it("on the hour, the band's label replaces the hour label instead of overlapping it", () => {
    render(<WeekGrid cars={cars} rides={[]} dayStartMinutes={0} nowQuarterMinutes={19 * 60} />);
    const band = screen.getByTestId("week-grid-now-quarter");
    expect(band.style.top).toBe("0%");
    expect(band.parentElement?.textContent).toBe("19:00");
  });

  it("shows nothing when the grid is not today", () => {
    render(<WeekGrid cars={cars} rides={[]} dayStartMinutes={0} />);
    expect(screen.queryByTestId("week-grid-now-quarter")).toBeNull();
  });
});
