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
    // Bold alone was not obvious on a phone: the header cell and my ride are tinted violet too.
    expect(names[0]?.parentElement).toHaveClass("bg-mine/25");
    expect(names[1]?.parentElement).not.toHaveClass("bg-mine/25");
    expect(container.querySelector('[data-ride-id="r1"]')).toHaveClass("bg-mine/25");
    expect(container.querySelector('[data-ride-id="r2"]')).not.toHaveClass("bg-mine/25");
  });

  it("marks today's column like my car (owner 2026-10-11, week view)", () => {
    const { container } = render(<WeekGrid cars={[{ id: "sun", name: "א׳ 11.10", today: true }, { id: "mon", name: "ב׳ 12.10" }]} rides={[]} />);
    const names = container.querySelectorAll('[data-testid="week-grid-car-name"]');
    expect(names[0]).toHaveAttribute("data-today", "true");
    expect(names[0]).toHaveClass("font-bold");
    expect(names[0]?.parentElement).toHaveClass("bg-mine/25");
    expect(names[1]).not.toHaveAttribute("data-today");
    expect(names[1]?.parentElement).not.toHaveClass("bg-mine/25");
  });

  it("with markMyColumns off only today is marked, my rides keep their lilac", () => {
    const rides = [{ id: "r1", carId: "mon", startMinutes: 480, endMinutes: 600, label: "mine", isMine: true }];
    const { container } = render(
      <WeekGrid cars={[{ id: "sun", name: "א׳ 11.10", today: true }, { id: "mon", name: "ב׳ 12.10" }]} rides={rides} markMyColumns={false} />,
    );
    const names = container.querySelectorAll('[data-testid="week-grid-car-name"]');
    expect(names[0]?.parentElement).toHaveClass("bg-mine/25");
    expect(names[1]?.parentElement).not.toHaveClass("bg-mine/25");
    expect(names[1]).not.toHaveAttribute("data-my-car");
    expect(container.querySelector('[data-ride-id="r1"]')).toHaveClass("bg-mine/25");
  });
});
