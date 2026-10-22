import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { WeekGrid } from "./WeekGrid";

const cars = [{ id: "a", name: "Car A" }];
const rides = [
  { id: "long", carId: "a", startMinutes: 480, endMinutes: 510, label: "Dana", description: "a long note that does not fit" },
  { id: "plain", carId: "a", startMinutes: 600, endMinutes: 720, label: "Avi" },
];

/** Owner 2026-10-22: a click on a ride shows its summary popup first; the second click (or the button) opens it. */
describe("WeekGrid ride popup", () => {
  it("the first click shows the summary with the whole note, the second opens the ride", () => {
    const onRideClick = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={rides} onRideClick={onRideClick} />);
    const ride = container.querySelector<HTMLElement>('[data-ride-id="long"]')!;

    fireEvent.click(ride);
    expect(onRideClick).not.toHaveBeenCalled();
    expect(screen.getByTestId("ride-notes-peek")).toHaveTextContent("a long note that does not fit");

    fireEvent.click(ride);
    expect(onRideClick).toHaveBeenCalledWith("long");
  });

  it("the popup's button opens the ride; a ride without notes gets the popup too", () => {
    const onRideClick = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={rides} onRideClick={onRideClick} />);
    fireEvent.click(container.querySelector('[data-ride-id="plain"]')!);
    expect(screen.getByTestId("ride-notes-peek")).toHaveTextContent("Avi");
    fireEvent.click(screen.getByRole("button", { name: he.screen.ride.detail }));
    expect(onRideClick).toHaveBeenCalledWith("plain");
  });

  it("a scroll closes the popup (not one right after it opened)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { container } = render(<WeekGrid cars={cars} rides={rides} onRideClick={vi.fn()} />);
    fireEvent.click(container.querySelector('[data-ride-id="long"]')!);
    fireEvent.scroll(window);
    expect(screen.getByTestId("ride-notes-peek")).toBeInTheDocument();
    vi.advanceTimersByTime(500);
    fireEvent.scroll(window);
    vi.useRealTimers();
    expect(screen.queryByTestId("ride-notes-peek")).toBeNull();
  });

  it("a finger drag closes the popup even when nothing scrolls", () => {
    const { container } = render(<WeekGrid cars={cars} rides={rides} onRideClick={vi.fn()} />);
    fireEvent.click(container.querySelector('[data-ride-id="long"]')!);
    fireEvent.touchStart(document.body, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(document.body, { touches: [{ clientX: 100, clientY: 140 }] });
    expect(screen.queryByTestId("ride-notes-peek")).toBeNull();
  });
});
