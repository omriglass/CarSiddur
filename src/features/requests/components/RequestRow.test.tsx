import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";
import type { MyRequestRow } from "../api";
import { toDisplayRows } from "../myRequestsRows";
import { RequestRow } from "./RequestRow";

function request(overrides: Partial<MyRequestRow> = {}): MyRequestRow {
  return {
    id: "request-1", departmentId: "dept-1", weekStart: "2026-09-13", status: "submitted",
    statusReason: null, isLate: false, changedSinceSolve: false, departAt: "2026-09-15T08:00:00+03:00",
    returnAt: "2026-09-15T12:00:00+03:00", tripShape: "round_trip", destination: "Destination",
    originId: null, originText: null, originName: null, stops: [], tripType: "round_trip",
    rideTypeId: "type-1", rideTypeName: "Type", rideTypeCode: null, needsCarAtDestination: true,
    version: 1, freedSlotOptOut: false, ride: null, pendingProposal: null, templateId: null,
    seriesId: null, seriesIndex: null, seriesCount: null,
    window: { phase: "open", open_at: "2026-09-01T00:00:00Z", close_at: "2026-09-12T23:00:00Z" },
    ...overrides,
  };
}

function show(row: MyRequestRow, props: Partial<Parameters<typeof RequestRow>[0]> = {}) {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-07T12:00:00Z"));
  const [display] = toDisplayRows([row]);
  return render(<MemoryRouter><RequestRow row={display!} {...props} /></MemoryRouter>);
}

describe("RequestRow", () => {
  it("ring-highlights when `highlighted` is set", () => {
    const { container } = show(request(), { highlighted: true });
    expect(container.querySelector('[data-request-id="request-1"]')?.className).toContain("ring-2");
  });

  it("does not highlight by default", () => {
    const { container } = show(request(), { highlighted: false });
    expect(container.querySelector('[data-request-id="request-1"]')?.className).not.toContain("ring-2");
  });

  it("shows named children on the card", () => {
    show(request({ childNames: ["Yossi", "Dana"] }));
    expect(screen.getByText(new RegExp("Yossi.*Dana"))).toBeInTheDocument();
  });

  it("renders no action buttons when readOnly", () => {
    show(request(), { readOnly: true, onWithdraw: vi.fn() });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: he.requestsList.edit })).not.toBeInTheDocument();
  });

  it("calls onWithdraw only after the caller wires it, for a request with no ride", () => {
    const onWithdraw = vi.fn();
    show(request(), { onWithdraw });
    fireEvent.click(screen.getByRole("button", { name: he.requestsList.withdraw }));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });

  it("shows cancel-ride instead of withdraw once a ride exists", () => {
    const onCancelRide = vi.fn();
    show(request({
      ride: {
        id: "ride-1", startsAt: "2026-09-15T08:00:00+03:00", endsAt: "2026-09-15T12:00:00+03:00", status: "confirmed",
        originName: "Home", destinationName: "Home", carName: "Car", carType: "shared", driverName: "Driver", isChauffeur: false, role: "driver", version: 1,
      },
    }), { onCancelRide });
    expect(screen.queryByRole("button", { name: he.requestsList.withdraw })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.requestsList.cancelRide }));
    expect(onCancelRide).toHaveBeenCalledTimes(1);
  });

  it("hides make-repeating and edit for a multi-day series card", () => {
    const [display] = toDisplayRows([
      request({ id: "leg-1", seriesId: "series-1", seriesIndex: 1, seriesCount: 2, status: "submitted", templateId: null }),
      request({ id: "leg-2", seriesId: "series-1", seriesIndex: 2, seriesCount: 2, status: "submitted", templateId: null }),
    ]);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-07T12:00:00Z"));
    render(<MemoryRouter><RequestRow row={display!} onMakeRepeating={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: he.request.makeRepeating })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: he.requestsList.edit })).not.toBeInTheDocument();
  });
  it("shows the 'be back on time' note with an accessible '!' when the parent passes one (REQ §13.108 f)", () => {
    show(request(), {
      handover: {
        notes: { returnBy: { rideId: "n", at: "2026-09-15T12:30:00+03:00", kind: "ride", name: "Dana", people: [], gapMinutes: 30, tight: true } },
        span: { startsAt: "2026-09-15T08:00:00+03:00", endsAt: "2026-09-15T12:00:00+03:00" },
      },
    });
    expect(screen.getByRole("img", { name: he.carHandover.alertLabel })).toHaveTextContent("!");
    expect(screen.getByTestId("car-handover-notice")).toHaveTextContent("Dana");
    expect(screen.getByTestId("car-handover-notice")).toHaveTextContent("12:30");
  });
});
