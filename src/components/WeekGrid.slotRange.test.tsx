import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { WeekGrid } from "./WeekGrid";

const cars = [{ id: "a", name: "Car A" }, { id: "b", name: "Car B" }];

beforeEach(() => {
  // A 1440px-tall column from 00:00: one pixel per minute.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = this.getAttribute("data-car-col-id") === "b" ? 200 : 0;
    const height = this.hasAttribute("data-week-grid-header") ? 0 : 1440;
    return { x: left, y: 0, top: 0, bottom: height, left, right: left + 100, width: 100, height, toJSON() {} };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

function column(container: HTMLElement, carId: string): HTMLElement {
  return container.querySelector(`[data-car-col-id="${carId}"]`) as HTMLElement;
}

/** Owner 2026-10-11: a first tap marks the start, a second tap the end. */
describe("WeekGrid two-tap span (onSlotRange)", () => {
  it("first tap marks the start, second tap reports the span", () => {
    const onSlotRange = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} dayStartMinutes={0} onSlotRange={onSlotRange} />);
    fireEvent.click(column(container, "a"), { clientY: 480 });
    expect(onSlotRange).not.toHaveBeenCalled();
    expect(screen.getByTestId("slot-range-start")).toHaveTextContent("08:00");
    fireEvent.click(column(container, "a"), { clientY: 600 });
    expect(onSlotRange).toHaveBeenCalledWith("a", 480, 600);
    expect(screen.queryByTestId("slot-range-start")).not.toBeInTheDocument();
  });

  it("an end tapped above the start still gives start < end; the same slot twice gives a zero-length span", () => {
    const onSlotRange = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} dayStartMinutes={0} onSlotRange={onSlotRange} />);
    fireEvent.click(column(container, "a"), { clientY: 600 });
    fireEvent.click(column(container, "a"), { clientY: 480 });
    expect(onSlotRange).toHaveBeenLastCalledWith("a", 480, 600);
    fireEvent.click(column(container, "a"), { clientY: 540 });
    fireEvent.click(column(container, "a"), { clientY: 540 });
    expect(onSlotRange).toHaveBeenLastCalledWith("a", 540, 540);
  });

  it("a tap in another column moves the start there", () => {
    const onSlotRange = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} dayStartMinutes={0} onSlotRange={onSlotRange} />);
    fireEvent.click(column(container, "a"), { clientY: 480 });
    fireEvent.click(column(container, "b"), { clientY: 540 });
    expect(onSlotRange).not.toHaveBeenCalled();
    fireEvent.click(column(container, "b"), { clientY: 660 });
    expect(onSlotRange).toHaveBeenCalledWith("b", 540, 660);
  });

  it("the ×, Escape, a ride tap and a new reset key clear a half-chosen span", () => {
    const onSlotRange = vi.fn();
    const ride = { id: "r", carId: "a", startMinutes: 900, endMinutes: 960, label: "ride" };
    const { container, rerender } = render(<WeekGrid cars={cars} rides={[ride]} dayStartMinutes={0} onSlotRange={onSlotRange} onRideClick={vi.fn()} rangeResetKey="sun" />);
    fireEvent.click(column(container, "a"), { clientY: 480 });
    fireEvent.click(screen.getByRole("button", { name: he.slotRange.cancel }));
    expect(screen.queryByTestId("slot-range-start")).not.toBeInTheDocument();

    fireEvent.click(column(container, "a"), { clientY: 480 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("slot-range-start")).not.toBeInTheDocument();

    fireEvent.click(column(container, "a"), { clientY: 480 });
    fireEvent.click(container.querySelector('[data-ride-id="r"]')!);
    expect(screen.queryByTestId("slot-range-start")).not.toBeInTheDocument();

    fireEvent.click(column(container, "a"), { clientY: 480 });
    rerender(<WeekGrid cars={cars} rides={[ride]} dayStartMinutes={0} onSlotRange={onSlotRange} onRideClick={vi.fn()} rangeResetKey="mon" />);
    expect(screen.queryByTestId("slot-range-start")).not.toBeInTheDocument();
    expect(onSlotRange).not.toHaveBeenCalled();
  });

  it("on a computer the span follows the mouse after the first click; a touch move shows nothing", () => {
    const { container } = render(<WeekGrid cars={cars} rides={[]} dayStartMinutes={0} onSlotRange={vi.fn()} />);
    fireEvent.click(column(container, "a"), { clientY: 480 });
    const move = (pointerType: string, clientY: number) => {
      const event = new MouseEvent("pointermove", { bubbles: true, clientY });
      Object.defineProperty(event, "pointerType", { value: pointerType });
      fireEvent(column(container, "a"), event);
    };
    move("touch", 600);
    expect(screen.queryByTestId("slot-range-preview")).not.toBeInTheDocument();
    move("mouse", 600);
    expect(screen.getByTestId("slot-range-preview")).toHaveTextContent("08:00–10:00");
    move("mouse", 420);
    expect(screen.getByTestId("slot-range-preview")).toHaveTextContent("07:00–08:00");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("slot-range-preview")).not.toBeInTheDocument();
  });

  it("without onSlotRange a tap still calls onSlotClick once", () => {
    const onSlotClick = vi.fn();
    const { container } = render(<WeekGrid cars={cars} rides={[]} dayStartMinutes={0} onSlotClick={onSlotClick} />);
    fireEvent.click(column(container, "a"), { clientY: 480 });
    expect(onSlotClick).toHaveBeenCalledWith("a", 480);
  });
});

describe("WeekGrid week-view blocks", () => {
  it("draws a suggestion dotted with its 'הצעה' tag, overlapping blocks in lanes, and calendar events faint and inert", () => {
    const rides = [
      { id: "s", carId: "a", startMinutes: 480, endMinutes: 600, label: "suggestion", kind: "suggestion" as const, lane: 1, laneCount: 2 },
      { id: "r", carId: "a", startMinutes: 480, endMinutes: 600, label: "ride", lane: 0, laneCount: 2 },
    ];
    const { container } = render(
      <WeekGrid cars={cars} rides={rides} dayStartMinutes={0} ambientBlocks={[{ id: "cal", carId: "a", startMinutes: 420, endMinutes: 540, label: "Dentist" }]} />,
    );
    const suggestion = container.querySelector('[data-ride-id="s"]') as HTMLElement;
    expect(suggestion).toHaveAttribute("data-kind", "suggestion");
    expect(suggestion).toHaveClass("border-dotted");
    expect(suggestion).toHaveTextContent(he.myWeek.kind.suggestion);
    expect(suggestion.style.width).toBe("calc(50% - 4px)");
    expect(suggestion).not.toHaveClass("inset-x-1");
    const ride = container.querySelector('[data-ride-id="r"]') as HTMLElement;
    expect(ride).not.toHaveAttribute("data-kind");
    expect(ride.querySelector('[data-testid="kind-tag"]')).toBeNull();
    const ambient = container.querySelector('[data-ambient-id="cal"]') as HTMLElement;
    expect(ambient).toHaveClass("pointer-events-none");
    expect(ambient).toHaveTextContent("Dentist");
  });
});
