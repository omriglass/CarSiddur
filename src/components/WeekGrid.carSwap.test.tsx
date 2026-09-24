import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { he } from "@/i18n/he";
import { WeekGrid } from "./WeekGrid";

const cars = [
  { id: "a", name: "Car A" },
  { id: "b", name: "Car B" },
  { id: "phantom:c", name: "Car C", group: "phantom" as const },
];

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const carId = this.getAttribute("data-car-col-id");
    const left = carId === "b" ? 200 : carId === "phantom:c" ? 400 : 0;
    return { x: left, y: 0, top: 0, bottom: 1440, left, right: left + 100, width: 100, height: 1440, toJSON() {} };
  });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/**
 * `WeekGrid`'s car-header drag/drop-to-swap (REQ §13.92, owner batch
 * 2026-09-24 S1). Hit-testing reuses the ride-drag's own `carIdAtClientX`
 * (by the body column's `data-car-col-id`, same X range as its header), so
 * these tests share the ride-drag tests' `getBoundingClientRect` mock
 * (`WeekGrid.gestures.test.tsx`).
 */
describe("WeekGrid car-swap header drag", () => {
  it("drags car A's header onto car B's header and reports the swap", () => {
    const onCarSwap = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} canSwapCars onCarSwap={onCarSwap} />);
    const headerA = container.querySelector('[data-car-header-id="a"]')!;
    fireEvent.pointerDown(headerA, { clientX: 50, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 20 });
    expect(container.querySelector("[data-car-swap-drag-preview]")).toHaveTextContent("Car A");
    fireEvent.pointerUp(window, { clientX: 250, clientY: 20 });
    expect(onCarSwap).toHaveBeenCalledWith("a", "b");
  });

  it("ignores a drop onto a phantom lane's header (never a real swap target)", () => {
    const onCarSwap = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} canSwapCars onCarSwap={onCarSwap} />);
    const headerA = container.querySelector('[data-car-header-id="a"]')!;
    fireEvent.pointerDown(headerA, { clientX: 50, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 450, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 450, clientY: 20 });
    expect(onCarSwap).not.toHaveBeenCalled();
  });

  it("does not call onCarSwap when the pointer never moves past the drag threshold (a plain tap)", () => {
    const onCarSwap = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} canSwapCars onCarSwap={onCarSwap} />);
    const headerA = container.querySelector('[data-car-header-id="a"]')!;
    fireEvent.pointerDown(headerA, { clientX: 50, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 20 });
    expect(onCarSwap).not.toHaveBeenCalled();
  });

  it("renders no drag affordance or menu on any header when canSwapCars is omitted (default behavior unchanged)", () => {
    const { container } = render(<WeekGrid cars={cars} rides={[]} />);
    expect(container.querySelector(`[aria-label="${he.carSwap.swapMenuLabel}"]`)).toBeNull();
  });

  it("offers the other real cars, excluding the phantom lane, from a header's own swap menu (keyboard/no-drag fallback)", () => {
    const { container } = render(<WeekGrid cars={cars} rides={[]} canSwapCars onCarSwap={vi.fn()} />);
    const menuButtons = container.querySelectorAll(`[aria-label="${he.carSwap.swapMenuLabel}"]`);
    // One menu trigger per real (non-phantom) car header.
    expect(menuButtons).toHaveLength(2);
  });
});
