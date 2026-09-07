import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";
import { RequestsListPage } from "@/pages/RequestsListPage";
import type { MyRequestRow } from "../api";

const mocks = vi.hoisted(() => ({ rows: [] as MyRequestRow[], withdrawAll: vi.fn() }));
vi.mock("../hooks", () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useMyRequests: () => ({ data: mocks.rows, isLoading: false }),
    useMyFreedSlotOffers: () => ({ data: [] }),
    useWithdrawAllRequestsMutation: () => ({ mutateAsync: mocks.withdrawAll, isPending: false }),
    useWithdrawRequestMutation: mutation,
    useCancelRideMutation: mutation,
    useClaimFreedSlotMutation: mutation,
    useSetFreedSlotOptOutMutation: mutation,
    useWithdrawFreedSlotClaimMutation: mutation,
  };
});

function request(overrides: Partial<MyRequestRow> = {}): MyRequestRow {
  return {
    id: "request-1", departmentId: "dept-1", weekStart: "2026-09-13", status: "submitted",
    statusReason: null, isLate: false, changedSinceSolve: false, departAt: "2026-09-15T08:00:00+03:00",
    returnAt: "2026-09-15T12:00:00+03:00", tripShape: "round_trip", destination: "Destination",
    rideTypeId: "type-1", rideTypeName: "Type", rideTypeCode: null, needsCarAtDestination: true,
    version: 1, freedSlotOptOut: false, ride: null, pendingProposal: null,
    window: { phase: "open", open_at: "2026-09-01T00:00:00Z", close_at: "2026-09-12T23:00:00Z" },
    ...overrides,
  };
}

function show() {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-07T12:00:00Z"));
  return render(<MemoryRouter><RequestsListPage /></MemoryRouter>);
}

afterEach(() => { vi.restoreAllMocks(); mocks.withdrawAll.mockReset(); });

describe("member request editing", () => {
  it("orders by actual assigned day, then requested day, and identifies each trip with its date, hours and purpose", () => {
    mocks.rows = [
      request({ id: "assigned", destination: "Moved ride", rideTypeName: "Errands", departAt: "2026-09-14T08:00:00+03:00", ride: {
        id: "ride", startsAt: "2026-09-17T10:00:00+03:00", endsAt: "2026-09-17T15:00:00+03:00", status: "confirmed",
        originName: "Home", destinationName: "Home", carName: "Car", carType: "shared", driverName: "Driver", isChauffeur: false, role: "driver",
      } }),
      request({ id: "later", destination: "Wednesday request", departAt: "2026-09-16T08:00:00+03:00", returnAt: "2026-09-16T12:00:00+03:00" }),
      request({ id: "return", destination: "Tuesday pickup", tripShape: "one_way_from", departAt: null, returnAt: "2026-09-15T09:00:00+03:00" }),
    ];
    const { container } = show();
    const summaries = [...container.querySelectorAll("[data-trip-summary]")];
    expect(summaries.map((summary) => summary.querySelector("p")?.textContent)).toEqual(["Tuesday pickup", "Wednesday request", "Moved ride"]);
    expect(summaries[0]).toHaveTextContent("15/9/2026");
    expect(summaries[0]).toHaveTextContent("09:00");
    expect(summaries[2]).toHaveTextContent(`${he.days.long[4]} 17/9/2026`);
    expect(summaries[2]).toHaveTextContent("10:00–15:00");
    expect(summaries[2]).toHaveTextContent("Errands");
  });

  it("requires confirmation and scopes rescinding to the selected department and week", async () => {
    mocks.rows = [request()];
    mocks.withdrawAll.mockResolvedValue(undefined);
    show();
    fireEvent.click(screen.getByRole("button", { name: he.requestsList.withdrawAll }));
    expect(mocks.withdrawAll).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: he.requestsList.withdrawAll }));
    expect(mocks.withdrawAll).toHaveBeenCalledWith({ kind: "withdrawAll", departmentId: "dept-1", weekStart: "2026-09-13" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the requests when the member dismisses confirmation", () => {
    mocks.rows = [request()];
    show();
    fireEvent.click(screen.getByRole("button", { name: he.requestsList.withdrawAll }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: he.common.cancel }));
    expect(mocks.withdrawAll).not.toHaveBeenCalled();
  });

  it("hides editing and bulk rescinding after the request window closes", () => {
    mocks.rows = [request({ window: { phase: "solving", open_at: "2026-09-01T00:00:00Z", close_at: "2026-09-06T23:00:00Z" } })];
    show();
    expect(screen.queryByRole("link", { name: he.requestsList.edit })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.requestsList.withdrawAll })).not.toBeInTheDocument();
  });
});
