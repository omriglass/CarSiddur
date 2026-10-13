import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { ruleSlices } from "../ruleExplain";
import { PolicyPie } from "./PolicyPie";

const slices = ruleSlices([
  { type: "rideType", weight: 3, params: {} },
  { type: "fairness", weight: 1, params: {} },
]);

describe("PolicyPie (REQ §13.133)", () => {
  it("a tap on a slice selects it; a tap on the chosen slice clears it", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<PolicyPie slices={slices} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("policy-slice-fairness"));
    expect(onSelect).toHaveBeenLastCalledWith("fairness");
    rerender(<PolicyPie slices={slices} selected="fairness" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("policy-slice-fairness"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("pulls the chosen slice out, fades the rest, and shows its share in the middle", () => {
    render(<PolicyPie slices={slices} selected="rideType" onSelect={vi.fn()} />);
    expect(screen.getByTestId("policy-slice-rideType").getAttribute("transform")).not.toBe("translate(0 0)");
    expect(screen.getByTestId("policy-slice-fairness").getAttribute("class")).toContain("opacity-40");
    expect(screen.getAllByText("75%").length).toBeGreaterThan(0);
  });

  it("names every slice with its share in the legend, which also selects", () => {
    const onSelect = vi.fn();
    render(<PolicyPie slices={slices} selected={null} onSelect={onSelect} />);
    expect(screen.getByTestId("policy-legend-rideType")).toHaveTextContent(he.adminPolicy.ruleNames.rideType);
    expect(screen.getByTestId("policy-legend-fairness")).toHaveTextContent("25%");
    fireEvent.click(screen.getByTestId("policy-legend-rideType"));
    expect(onSelect).toHaveBeenCalledWith("rideType");
  });
});
