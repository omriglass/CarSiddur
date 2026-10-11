import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WeekGrid } from "./WeekGrid";

const ride = { id: "ride", carId: "a", startMinutes: 600, endMinutes: 720, label: "Driver and destination" };
const cars = [{ id: "a", name: "Car A" }];

// Unlike WeekGrid.gestures.test, every element does not share one rect: the day column is 1440px tall (one pixel per
// minute from 00:00) while a ride block is only its own 120px — so measuring against the wrong element shows.
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = this.hasAttribute("data-week-grid-header") ? 0 : this.hasAttribute("data-ride-id") ? 120 : 1440;
    const top = this.hasAttribute("data-ride-id") ? 600 : 0;
    return { x: 0, y: top, top, bottom: top + height, left: 0, right: 100, width: 100, height, toJSON() {} };
  });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WeekGrid top-edge resize (owner 2026-10-11: dragging from above moved several times too far)", () => {
  it("moves the start by exactly the dragged distance, like the bottom edge", () => {
    const resize = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[ride]} dayStartMinutes={0} readOnly={false} draggable onRideResize={resize} />);
    const top = container.querySelector('[data-ride-id="ride"] .top-0.cursor-ns-resize');
    expect(top).toBeTruthy();
    fireEvent.pointerDown(top!, { clientX: 50, clientY: 600 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 570 });
    expect(container.querySelector("[data-drag-preview]")).toHaveTextContent("09:30–12:00");
    fireEvent.pointerUp(window, { clientX: 50, clientY: 570 });
    expect(resize).toHaveBeenCalledWith("ride", "start", 570);
  });
});
