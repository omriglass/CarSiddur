import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FLEX_VALUES, FlexibilitySegmented, type FlexValue } from "./FlexibilitySegmented";
import { he } from "@/i18n/he";

describe("FLEX_VALUES", () => {
  it("has the six REQUIREMENTS §5.3 values in order", () => {
    expect(FLEX_VALUES).toEqual([0, 15, 30, 60, 120, "any"]);
  });
});

describe("FlexibilitySegmented", () => {
  it("renders one option per flex value with its Hebrew label", () => {
    render(<FlexibilitySegmented value={0} onChange={() => {}} />);
    expect(screen.getByText(he.flex["0"])).toBeInTheDocument();
    expect(screen.getByText(he.flex["15"])).toBeInTheDocument();
    expect(screen.getByText(he.flex["30"])).toBeInTheDocument();
    expect(screen.getByText(he.flex["60"])).toBeInTheDocument();
    expect(screen.getByText(he.flex["120"])).toBeInTheDocument();
    expect(screen.getByText(he.flex.anyTime)).toBeInTheDocument();
  });

  it("calls onChange with the selected flex value", () => {
    const onChange = vi.fn<(value: FlexValue) => void>();
    render(<FlexibilitySegmented value={0} onChange={onChange} />);
    fireEvent.click(screen.getByText(he.flex["30"]));
    expect(onChange).toHaveBeenCalledWith(30);
  });

  it("calls onChange with 'any' for the last option", () => {
    const onChange = vi.fn<(value: FlexValue) => void>();
    render(<FlexibilitySegmented value={0} onChange={onChange} />);
    fireEvent.click(screen.getByText(he.flex.anyTime));
    expect(onChange).toHaveBeenCalledWith("any");
  });
});
