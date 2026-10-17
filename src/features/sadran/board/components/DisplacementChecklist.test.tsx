import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import type { ChecklistStep } from "../displacementChecklist";
import { DisplacementChecklist } from "./DisplacementChecklist";

const weekStartMs = Date.parse("2026-10-18T00:00:00+03:00");
const steps: ChecklistStep[] = [
  { key: "u", kind: "unplace", requestId: "a", fromCarId: "c1", window: { start: 4 * 96 + 40, end: 4 * 96 + 50 }, rideIds: ["RA"], done: false },
  { key: "p", kind: "place", requestId: "h", carId: "c1", window: { start: 4 * 96 + 40, end: 4 * 96 + 80 }, rideIds: [], done: false },
];

function setup(over: Partial<React.ComponentProps<typeof DisplacementChecklist>> = {}) {
  const props = {
    steps, weekStartMs, selectedDay: "2026-10-22", carName: (id: string) => `car-${id}`, requesterName: (id: string) => `who-${id}`,
    series: false, busy: false, onGoToDay: vi.fn(), onUnplace: vi.fn(), onMove: vi.fn(), onPlace: vi.fn(), onShow: vi.fn(), onClose: vi.fn(), ...over,
  };
  render(<DisplacementChecklist {...props} />);
  return props;
}

describe("DisplacementChecklist", () => {
  it("unplaces only after the confirmation", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: he.displacement.doUnplace }));
    expect(props.onUnplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: he.displacement.unplaceConfirm }));
    expect(props.onUnplace).toHaveBeenCalledWith("RA");
  });
  it("places the target and marks done steps without a button", () => {
    const props = setup({ steps: [{ ...steps[0]!, done: true, rideIds: [] }, steps[1]!] });
    expect(screen.getByTestId("displacement-step-unplace")).toHaveAttribute("data-done", "true");
    fireEvent.click(screen.getByRole("button", { name: he.displacement.doPlace }));
    expect(props.onPlace).toHaveBeenCalledWith(steps[1]);
  });
  it("asks to go to the step's day first when it is not the selected day", () => {
    const props = setup({ selectedDay: "2026-10-19" });
    fireEvent.click(screen.getAllByRole("button", { name: he.displacement.goToDay })[0]!);
    expect(props.onGoToDay).toHaveBeenCalledWith("2026-10-22");
  });
});
