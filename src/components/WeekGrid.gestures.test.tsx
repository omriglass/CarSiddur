import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeekGrid } from "./WeekGrid";

const ride = { id: "ride", carId: "a", startMinutes: 600, endMinutes: 720, label: "Driver and destination" };
const cars = [{ id: "a", name: "Car A" }, { id: "b", name: "Car B" }];

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = this.getAttribute("data-car-col-id") === "b" ? 200 : 0;
    return { x: left, y: 0, top: 0, bottom: 1440, left, right: left + 100, width: 100, height: 1440, toJSON() {} };
  });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WeekGrid gestures", () => {
  it("previews and drops the exact same snapped car/time while retaining the column DOM", () => {
    const onDrop = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[ride]} dayStartMinutes={0} readOnly={false} draggable onRideDrop={onDrop} />);
    const column = container.querySelector('[data-car-col-id="a"]');
    fireEvent.pointerDown(container.querySelector('[data-ride-id="ride"]')!, { clientX: 50, clientY: 650 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 680 });
    expect(container.querySelector('[data-car-col-id="a"]')).toBe(column);
    expect(container.querySelector('[data-drag-preview]')).toHaveTextContent("Car B10:30–12:30");
    fireEvent.pointerUp(window, { clientX: 250, clientY: 680 });
    expect(onDrop).toHaveBeenCalledWith("ride", "b", 630, undefined);
  });
  it("resizes the end independently and respects ownership for other rides", () => {
    const resize = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[ride, { ...ride, id: "other", carId: "b" }]} dayStartMinutes={0} readOnly={false} draggable canDragRide={(r) => r.id === "ride"} onRideResize={resize} />);
    const edge = container.querySelector('[data-ride-id="ride"] .bottom-0');
    expect(edge).toBeTruthy();
    expect(container.querySelector('[data-ride-id="other"] .bottom-0')).toBeNull();
    fireEvent.pointerDown(edge!, { clientX: 50, clientY: 720 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 750 });
    expect(container.querySelector('[data-drag-preview]')).toHaveTextContent("10:00–12:30");
    fireEvent.pointerUp(window, { clientX: 50, clientY: 750 });
    expect(resize).toHaveBeenCalledWith("ride", "end", 750);
  });
  it("keeps pending changes visible alongside half-opacity originals without allowing ghost edits", () => {
    const onDrop = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[
      { ...ride, shadowed: true }, { ...ride, id: "change:pending", carId: "b", pendingConsent: true, label: "Pending move" },
    ]} dayStartMinutes={0} readOnly={false} draggable canDragRide={(item) => !item.id.startsWith("change:")} onRideDrop={onDrop} />);
    expect(container.querySelector('[data-ride-id="ride"]')).toHaveClass("opacity-50");
    const ghost = container.querySelector('[data-ride-id="change:pending"]')!;
    expect(ghost).toHaveClass("border-dashed");
    fireEvent.pointerDown(ghost, { clientX: 250, clientY: 650 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 680 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 680 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("uses a reservation preview without changing the passenger drop anchor", () => {
    const onDrop = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[ride]} dayStartMinutes={0} readOnly={false} draggable onRideDrop={onDrop}
      resolveDropPreview={(_ride, _car, startMinutes) => ({ startMinutes: startMinutes - 30, endMinutes: startMinutes + 60 })} />);
    fireEvent.pointerDown(container.querySelector('[data-ride-id="ride"]')!, { clientX: 50, clientY: 650 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 680 });
    expect(container.querySelector('[data-drag-preview]')).toHaveTextContent("10:00–11:30");
    fireEvent.pointerUp(window, { clientX: 250, clientY: 680 });
    expect(onDrop).toHaveBeenCalledWith("ride", "b", 630, undefined);
  });
  it("shows missing driver and tight turnaround indicators on the ride itself", () => {
    const { container } = render(<WeekGrid cars={cars} rides={[{ ...ride, needsDriver: true, tightSchedule: true }]} />);
    const block = container.querySelector('[data-ride-id="ride"]')!;
    expect(block).toHaveAttribute("data-needs-driver", "true");
    expect(block).toHaveAttribute("data-tight-schedule", "true");
    expect(block).toHaveClass("border-destructive");
  });

});
