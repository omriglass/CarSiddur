import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_TO_DRAG_MS } from "./holdGesture";
import { WeekGrid } from "./WeekGrid";

// Owner 2026-10-30: edit mode off (member siddur / my rides) - a ride drags only after a long press.
const ride = { id: "ride", carId: "a", startMinutes: 600, endMinutes: 720, label: "Driver and destination" };
const cars = [{ id: "a", name: "Car A" }, { id: "b", name: "Car B" }];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = this.getAttribute("data-car-col-id") === "b" ? 200 : 0;
    const height = this.hasAttribute("data-week-grid-header") ? 0 : 1440;
    return { x: left, y: 0, top: 0, bottom: height, left, right: left + 100, width: 100, height, toJSON() {} };
  });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function grid(props: Partial<Parameters<typeof WeekGrid>[0]> = {}) {
  const onDrop = vi.fn();
  const onHint = vi.fn();
  const view = render(<WeekGrid cars={cars} rides={[ride, { ...ride, id: "other", carId: "b" }]} dayStartMinutes={0} readOnly={false} draggable
    canDragRide={(r) => r.id === "ride"} onRideDrop={onDrop} holdToDrag onDragHint={onHint} {...props} />);
  return { ...view, onDrop, onHint, block: (id: string) => view.container.querySelector(`[data-ride-id="${id}"]`)! };
}

describe("WeekGrid hold to drag", () => {
  it("a drag without a long press moves nothing and reports an attempt", () => {
    const { block, onDrop, onHint } = grid();
    fireEvent.pointerDown(block("ride"), { clientX: 50, clientY: 650 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 680 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 680 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onHint).toHaveBeenCalledWith("locked");
  });

  it("two locked drags never make the two-tap span under the pointer", () => {
    const onSlotRange = vi.fn();
    const { block, container } = grid({ onSlotRange });
    const column = container.querySelector('[data-car-col-id="a"]')!;
    for (let i = 0; i < 2; i += 1) {
      fireEvent.pointerDown(block("ride"), { clientX: 50, clientY: 650 });
      fireEvent.pointerMove(window, { clientX: 50, clientY: 800 });
      fireEvent.pointerUp(window, { clientX: 50, clientY: 800 });
      fireEvent.click(column, { clientX: 50, clientY: 800 });
    }
    expect(onSlotRange).not.toHaveBeenCalled();
  });

  it("after a long press the ride drags as usual", () => {
    const { block, onDrop, onHint } = grid();
    fireEvent.pointerDown(block("ride"), { clientX: 50, clientY: 650 });
    act(() => { vi.advanceTimersByTime(HOLD_TO_DRAG_MS); });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 680 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 680 });
    expect(onDrop).toHaveBeenCalledWith("ride", "b", 630, undefined);
    expect(onHint).not.toHaveBeenCalled();
  });

  it("a long press let go in place opens nothing and moves nothing", () => {
    const onRideClick = vi.fn();
    const { block, onDrop } = grid({ onRideClick });
    fireEvent.pointerDown(block("ride"), { clientX: 50, clientY: 650 });
    act(() => { vi.advanceTimersByTime(HOLD_TO_DRAG_MS); });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 650 });
    fireEvent.click(block("ride"));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onRideClick).not.toHaveBeenCalled();
  });

  it("someone else's ride never drags and says it is not yours", () => {
    const { block, onDrop, onHint } = grid({ holdToDrag: false });
    fireEvent.pointerDown(block("other"), { clientX: 250, clientY: 650 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 700 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 700 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onHint).toHaveBeenCalledWith("notYours");
  });

  it("edit mode on: the ride drags at once and blocks do not scroll the page", () => {
    const { block, onDrop } = grid({ holdToDrag: false });
    expect(block("ride")).toHaveClass("touch-none");
    fireEvent.pointerDown(block("ride"), { clientX: 50, clientY: 650 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 680 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 680 });
    expect(onDrop).toHaveBeenCalledWith("ride", "b", 630, undefined);
  });

  it("edit mode off: blocks scroll the page (no touch-none)", () => {
    const { block } = grid();
    expect(block("ride")).not.toHaveClass("touch-none");
  });
});

describe("WeekGrid short-ride tap area (REQ 13.185 e)", () => {
  const short = { id: "s1", carId: "a", startMinutes: 600, endMinutes: 615, label: "Short one" };
  const next = { id: "s2", carId: "a", startMinutes: 615, endMinutes: 630, label: "Short two" };

  it("a short ride gets an invisible hit area that opens it; a real neighbour block still wins its own click", () => {
    const onRideClick = vi.fn();
    const { container, block } = grid({ rides: [short, next], onRideClick });
    const hit = container.querySelector('[data-ride-hit="s1"]')!;
    expect(hit).not.toBeNull();
    // Same as tapping the block: the first tap peeks, the second opens the ride.
    fireEvent.click(hit);
    fireEvent.click(hit);
    expect(onRideClick).toHaveBeenLastCalledWith("s1");
    fireEvent.click(block("s2"));
    fireEvent.click(block("s2"));
    expect(onRideClick).toHaveBeenLastCalledWith("s2");
  });

  it("a long ride has no extra hit area", () => {
    const { container } = grid({ rides: [ride] });
    expect(container.querySelector("[data-ride-hit]")).toBeNull();
  });
});
