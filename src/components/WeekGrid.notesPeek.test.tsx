import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { WeekGrid } from "./WeekGrid";

const cars = [{ id: "a", name: "Car A" }];
const rides = [
  { id: "long", carId: "a", startMinutes: 480, endMinutes: 510, label: "Dana", description: "a long note that does not fit" },
  { id: "plain", carId: "a", startMinutes: 600, endMinutes: 720, label: "Avi" },
];

function stubHover(hover: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: none)" ? !hover : false, addEventListener() {}, removeEventListener() {} }));
}

/** Owner 2026-10-22: ride notes fill the block; on a phone a first tap on cut notes shows them, the second opens the ride. */
describe("WeekGrid notes peek", () => {
  beforeEach(() => {
    // jsdom lays nothing out: every notes element reports more text than room.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-ride-notes") ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => 20);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("on touch, the first tap on cut notes shows them and the second opens the ride", () => {
    stubHover(false);
    const onRideClick = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={rides} onRideClick={onRideClick} />);
    const ride = container.querySelector<HTMLElement>('[data-ride-id="long"]')!;
    expect(ride.querySelector("[data-ride-notes]")).toHaveAttribute("data-truncated");

    fireEvent.click(ride);
    expect(onRideClick).not.toHaveBeenCalled();
    expect(screen.getByTestId("ride-notes-peek")).toHaveTextContent("a long note that does not fit");

    fireEvent.click(ride);
    expect(onRideClick).toHaveBeenCalledWith("long");
  });

  it("the popup's button opens the ride", () => {
    stubHover(false);
    const onRideClick = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={rides} onRideClick={onRideClick} />);
    fireEvent.click(container.querySelector('[data-ride-id="long"]')!);
    fireEvent.click(screen.getByRole("button", { name: he.screen.ride.detail }));
    expect(onRideClick).toHaveBeenCalledWith("long");
  });

  it("a ride without notes, or a mouse, opens at once", () => {
    stubHover(false);
    const onRideClick = vi.fn();
    const { container, unmount } = render(<WeekGrid cars={cars} rides={rides} onRideClick={onRideClick} />);
    fireEvent.click(container.querySelector('[data-ride-id="plain"]')!);
    expect(onRideClick).toHaveBeenCalledWith("plain");
    unmount();

    stubHover(true);
    const onMouseClick = vi.fn();
    const mouse = render(<WeekGrid cars={cars} rides={rides} onRideClick={onMouseClick} />);
    fireEvent.click(mouse.container.querySelector('[data-ride-id="long"]')!);
    expect(onMouseClick).toHaveBeenCalledWith("long");
    expect(screen.queryByTestId("ride-notes-peek")).toBeNull();
  });
});
