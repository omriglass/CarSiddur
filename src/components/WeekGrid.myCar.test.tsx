import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WeekGrid } from "./WeekGrid";

const cars = [
  { id: "a", name: "Car A" },
  { id: "b", name: "Car B" },
];

/** Owner 2026-10-09: on the shown day, the header of every car the viewer rides in is bold. */
describe("WeekGrid my-car header", () => {
  it("bolds only the cars with one of my rides", () => {
    const rides = [
      { id: "r1", carId: "a", startMinutes: 480, endMinutes: 600, label: "mine", isMine: true },
      { id: "r2", carId: "b", startMinutes: 480, endMinutes: 600, label: "someone else" },
    ];
    const { container } = render(<WeekGrid cars={cars} rides={rides} />);
    const names = container.querySelectorAll('[data-testid="week-grid-car-name"]');
    expect(names[0]).toHaveAttribute("data-my-car", "true");
    expect(names[0]).toHaveClass("font-bold");
    expect(names[1]).not.toHaveAttribute("data-my-car");
    expect(names[1]).toHaveClass("font-medium");
  });
});
