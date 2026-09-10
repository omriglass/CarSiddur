import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import type { RideTypeStat } from "../types";
import { RideTypePie } from "./RideTypePie";

const data: RideTypeStat[] = [
  { rideTypeId: "11111111-1111-1111-1111-111111111111", code: "work", name: "עבודה", rides: 80, hours: 210.5 },
  { rideTypeId: "22222222-2222-2222-2222-222222222222", code: "childcare", name: "ילדים", rides: 20, hours: 40 },
  { rideTypeId: null, code: "other", name: null, rides: 5, hours: 6 },
];

describe("RideTypePie", () => {
  it("renders one legend row per ride type with rides count and percentage", () => {
    render(<RideTypePie data={data} />);
    expect(screen.getByTestId("stats-ridetype-row-work")).toHaveTextContent("עבודה");
    expect(screen.getByTestId("stats-ridetype-row-work")).toHaveTextContent("80");
    expect(screen.getByTestId("stats-ridetype-row-work")).toHaveTextContent("76%");
  });

  it("falls back to the 'other' label for a null name", () => {
    render(<RideTypePie data={data} />);
    expect(screen.getByTestId("stats-ridetype-row-other")).toHaveTextContent(he.stats.otherRideType);
  });

  it("shows the total rides count at the donut center", () => {
    render(<RideTypePie data={data} />);
    expect(screen.getByText("105")).toBeInTheDocument();
  });

  it("carries every value in a screen-reader summary", () => {
    render(<RideTypePie data={data} />);
    const summary = screen.getByTestId("stats-ridetype-sr-summary");
    expect(summary).toHaveTextContent("עבודה");
    expect(summary).toHaveTextContent("ילדים");
    expect(summary.className).toContain("sr-only");
  });

  it("renders the empty state when there are no rides", () => {
    render(<RideTypePie data={[]} />);
    expect(screen.getByTestId("stats-ridetype-empty")).toHaveTextContent(he.stats.rideTypePie.empty);
  });

  it("renders the empty state when every ride type has zero rides", () => {
    render(<RideTypePie data={[{ rideTypeId: null, code: "other", name: "אחר", rides: 0, hours: 0 }]} />);
    expect(screen.getByTestId("stats-ridetype-empty")).toBeInTheDocument();
  });
});
