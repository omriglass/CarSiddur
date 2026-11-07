import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WeekGrid } from "./WeekGrid";

describe("WeekGrid freshly washed car (WS1)", () => {
  it("shows the sparkle only on cars in the set", () => {
    const cars = [{ id: "a", name: "Car A" }, { id: "b", name: "Car B" }];
    const { container } = render(<WeekGrid cars={cars} rides={[]} recentlyWashedCarIds={new Set(["a"])} />);
    expect(container.querySelector('[data-car-header-id="a"] [data-testid="car-sparkle"]')).not.toBeNull();
    expect(container.querySelector('[data-car-header-id="b"] [data-testid="car-sparkle"]')).toBeNull();
  });
});
