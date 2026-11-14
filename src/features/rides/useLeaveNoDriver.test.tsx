// R20B15: "בלי נהג/ת" asks "לקצר את הנסיעה?" when the riders left need fewer hours.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import type { BoardRide } from "./api";
import { useLeaveNoDriver } from "./useLeaveNoDriver";

const m = vi.hoisted(() => ({
  preview: null as { startsAt: string; endsAt: string } | null,
  leave: vi.fn(),
  fit: vi.fn(async () => undefined),
}));
vi.mock("./api", () => ({ leaveRideFitPreview: vi.fn(async () => m.preview) }));
vi.mock("./hooks", () => ({
  useLeaveMergedRideMutation: () => ({ mutate: m.leave, isPending: false }),
  useLeaveMergedRideFitMutation: () => ({ mutateAsync: m.fit, isPending: false }),
}));
vi.mock("./freedCarPreview", () => ({ fetchFreedCarLine: vi.fn(async () => null) }));

const ride = {
  id: "r1", version: 3, department_id: "d", week_start: "2026-11-15",
  starts_at: "2026-11-16T04:45:00Z", ends_at: "2026-11-16T16:00:00Z",
} as unknown as BoardRide;

function Harness({ onNoFit }: { onNoFit?: () => void }) {
  const leave = useLeaveNoDriver();
  return (
    <>
      <button type="button" onClick={() => void leave.start(ride, "דנה", () => undefined, null, onNoFit)}>go</button>
      {leave.dialog}
    </>
  );
}

async function go(onNoFit?: () => void) {
  render(<Harness onNoFit={onNoFit} />);
  await act(async () => { fireEvent.click(screen.getByText("go")); });
}

describe("useLeaveNoDriver (R20B15)", () => {
  beforeEach(() => {
    m.preview = { startsAt: "2026-11-16T05:00:00Z", endsAt: "2026-11-16T05:45:00Z" };
    m.leave.mockClear();
    m.fit.mockClear();
  });

  it("nothing to shrink: leaves at once, or hands back to the caller's confirmation", async () => {
    m.preview = null;
    await go();
    expect(m.leave).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(he.rideDetail.leaveFitTitle)).toBeNull();
    cleanup();
    const onNoFit = vi.fn();
    await go(onNoFit);
    expect(onNoFit).toHaveBeenCalledTimes(1);
    expect(m.leave).toHaveBeenCalledTimes(1);
  });

  it("asks with the owner's wording: shrink to 07:00–07:45, keep 06:45–18:00, back", async () => {
    await go();
    expect(screen.getByText(he.rideDetail.leaveFitTitle)).toBeTruthy();
    expect(screen.getByText("בלי דנה הנסיעה צריכה רק 07:00–07:45. לקצר אותה ולשחרר את הרכב בשאר השעות?")).toBeTruthy();
    expect(screen.getByTestId("leave-fit-shrink").textContent).toBe("לקצר ל־07:00–07:45");
    expect(screen.getByTestId("leave-fit-keep").textContent).toBe("להשאיר 06:45–18:00");
    expect(screen.getByRole("button", { name: he.freedCar.confirmBack })).toBeTruthy();
  });

  it("\"לקצר\" leaves and shrinks in one call", async () => {
    await go();
    await act(async () => { fireEvent.click(screen.getByTestId("leave-fit-shrink")); });
    expect(m.fit).toHaveBeenCalledWith({ rideId: "r1", expectedVersion: 3, departmentId: "d", weekStart: "2026-11-15" });
    expect(m.leave).not.toHaveBeenCalled();
  });

  it("\"להשאיר\" leaves the ride at its hours", async () => {
    await go();
    await act(async () => { fireEvent.click(screen.getByTestId("leave-fit-keep")); });
    expect(m.leave).toHaveBeenCalledTimes(1);
    expect(m.fit).not.toHaveBeenCalled();
  });
});
