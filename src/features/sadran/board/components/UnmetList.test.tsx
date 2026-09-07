import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeekRequestRow } from "../../api";
import { he } from "@/i18n/he";
import { UnmetList } from "./UnmetList";

const request = {
  id: "return-request", trip_shape: "one_way_from", depart_at: null, return_at: "2026-09-10T06:00:00Z",
  one_way_car_mode: "passenger", destination_travel_minutes: 40, status: "submitted", requester_full_name: "Member",
} as WeekRequestRow;
const item = { request, destinationName: "Destination" };

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const column = document.createElement("div");
  column.setAttribute("data-car-col-id", "car");
  vi.spyOn(column, "getBoundingClientRect").mockReturnValue({ top: 0, height: 1440 } as DOMRect);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => column });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("one-way unmet cards", () => {
  it("shows the journey ending at arrival and supports dragging it for a proposal", () => {
    const drop = vi.fn();
    render(<UnmetList items={[item]} onAction={vi.fn()} onDragDrop={drop} dayStartMinutes={0} />);
    expect(screen.getByText(/08:15–09:00/)).toBeInTheDocument();
    const grip = screen.getByRole("button", { name: "גרור/י ללוח" });
    fireEvent.pointerDown(grip, { clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 600 });
    fireEvent.pointerUp(window, { clientX: 200, clientY: 600 });
    expect(drop).toHaveBeenCalledWith(item, "car", 600, undefined);
  });
  it("offers only time changes and outside-siddur solutions without a solver suggestion", () => {
    const decide = vi.fn();
    render(<UnmetList items={[item]} onAction={vi.fn()} onDecision={decide} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: he.sadranProposal.suggestTimes }));
    fireEvent.click(screen.getByRole("button", { name: he.sadranProposal.solveOutside }));
    expect(decide.mock.calls).toEqual([[item, "shift"], [item, "external"]]);
    expect(screen.queryByRole("button", { name: he.action.deny })).not.toBeInTheDocument();
  });

  it("a click on the grip never places a request", () => {
    const drop = vi.fn();
    render(<UnmetList items={[item]} onAction={vi.fn()} onDragDrop={drop} />);
    const grip = screen.getByRole("button", { name: "גרור/י ללוח" });
    fireEvent.pointerDown(grip, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 20, clientY: 20 });
    expect(drop).not.toHaveBeenCalled();
  });
});
