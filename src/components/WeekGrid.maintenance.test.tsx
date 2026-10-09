import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WeekGrid } from "./WeekGrid";

const cars = [{ id: "a", name: "Car A" }];
// 10:00-14:00 maintenance band on car A (REQ §13.114); the mocked column is 1 px per minute (height 1440).
const band = { id: "m1", carId: "a", startMinutes: 600, endMinutes: 840, kind: "maintenance" as const, editable: true };

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    return { x: 0, y: 0, top: 0, bottom: 1440, left: 0, right: 100, width: 100, height: 1440, toJSON() {} };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WeekGrid maintenance bands (REQ §13.114)", () => {
  it("a band the viewer may not edit has no handles and never reports a drag", () => {
    const onChange = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} blocks={[{ ...band, editable: false }]} dayStartMinutes={0} onBlockChange={onChange} />);
    const el = container.querySelector('[data-block-id="m1"]')!;
    expect(el).not.toHaveAttribute("data-block-editable");
    expect(container.querySelector("[data-block-handle]")).toBeNull();
    fireEvent.pointerDown(el, { clientX: 50, clientY: 700 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 760 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 760 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("dragging the body moves the whole band, snapped to 15 minutes", () => {
    const onChange = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} blocks={[band]} dayStartMinutes={0} onBlockChange={onChange} />);
    fireEvent.pointerDown(container.querySelector('[data-block-id="m1"]')!, { clientX: 50, clientY: 700 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 761 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 761 });
    expect(onChange).toHaveBeenCalledWith("m1", "move", 60);
  });

  it("the bottom handle resizes the end, the top handle the start", () => {
    const onChange = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} blocks={[band]} dayStartMinutes={0} onBlockChange={onChange} />);
    fireEvent.pointerDown(container.querySelector('[data-block-handle="end"]')!, { clientX: 50, clientY: 840 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 780 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 780 });
    expect(onChange).toHaveBeenLastCalledWith("m1", "end", -60);
    fireEvent.pointerDown(container.querySelector('[data-block-handle="start"]')!, { clientX: 50, clientY: 600 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 645 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 645 });
    expect(onChange).toHaveBeenLastCalledWith("m1", "start", 45);
  });

  it("an edge the grid's day clips has no handle; a resize never makes the band shorter than 15 minutes", () => {
    const onChange = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} blocks={[{ ...band, clippedEnd: true }]} dayStartMinutes={0} onBlockChange={onChange} />);
    expect(container.querySelector('[data-block-handle="end"]')).toBeNull();
    fireEvent.pointerDown(container.querySelector('[data-block-handle="start"]')!, { clientX: 50, clientY: 600 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 1200 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 1200 });
    expect(onChange).toHaveBeenCalledWith("m1", "start", 225);
  });

  it("a click (no drag) opens the band; a drag does not also count as a click", () => {
    const onClick = vi.fn();
    const onChange = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} blocks={[band]} dayStartMinutes={0} onBlockChange={onChange} onBlockClick={onClick} />);
    const el = container.querySelector('[data-block-id="m1"]')!;
    fireEvent.pointerDown(el, { clientX: 50, clientY: 700 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 700 });
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(el, { clientX: 50, clientY: 700 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 760 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 760 });
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
