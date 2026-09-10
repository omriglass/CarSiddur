import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { he, tv } from "@/i18n/he";
import { RequestsListPage } from "@/pages/RequestsListPage";
import type { MyRequestRow } from "../api";

// jsdom has no `Element.scrollIntoView`; the `?focus=` highlight effect calls it on mount.
Element.prototype.scrollIntoView ??= () => {};

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
    useSaveRequestTemplateMutation: mutation,
  };
});

function request(overrides: Partial<MyRequestRow> = {}): MyRequestRow {
  return {
    id: "request-1", departmentId: "dept-1", weekStart: "2026-09-13", status: "submitted",
    statusReason: null, isLate: false, changedSinceSolve: false, departAt: "2026-09-15T08:00:00+03:00",
    returnAt: "2026-09-15T12:00:00+03:00", tripShape: "round_trip", destination: "Destination",
    rideTypeId: "type-1", rideTypeName: "Type", rideTypeCode: null, needsCarAtDestination: true,
    version: 1, freedSlotOptOut: false, ride: null, pendingProposal: null, templateId: null,
    seriesId: null, seriesIndex: null, seriesCount: null,
    window: { phase: "open", open_at: "2026-09-01T00:00:00Z", close_at: "2026-09-12T23:00:00Z" },
    ...overrides,
  };
}

function show(initialEntries: string[] = ["/requests"]) {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-07T12:00:00Z"));
  return render(<MemoryRouter initialEntries={initialEntries}><RequestsListPage /></MemoryRouter>);
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

  it("ring-highlights the card named by ?focus= (notification deep link)", () => {
    mocks.rows = [request({ id: "other" }), request({ id: "notified", destination: "Notified stop" })];
    const { container } = show(["/requests?focus=notified"]);
    const focused = container.querySelector('[data-request-id="notified"]');
    const unfocused = container.querySelector('[data-request-id="other"]');
    expect(focused?.className).toContain("ring-2");
    expect(unfocused?.className).not.toContain("ring-2");
  });

  it("shows named children on a request's own card", () => {
    mocks.rows = [request({ childNames: ["Yossi", "Dana"] })];
    show();
    expect(screen.getByText(new RegExp("Yossi.*Dana"))).toBeInTheDocument();
  });

  it("offers to make a submitted request repeating when it has no template yet", () => {
    mocks.rows = [request({ status: "submitted", templateId: null })];
    show();
    expect(screen.getByRole("button", { name: he.request.makeRepeating })).toBeVisible();
    expect(screen.queryByText(he.request.repeating)).not.toBeInTheDocument();
  });

  it("shows the repeating flag instead of the action once a template is linked", () => {
    mocks.rows = [request({ status: "submitted", templateId: "template-1" })];
    show();
    expect(screen.queryByRole("button", { name: he.request.makeRepeating })).not.toBeInTheDocument();
    expect(screen.getByText(he.request.repeating)).toBeVisible();
  });

  it("groups a multi-day request's legs into one card spanning the first depart to the last return", () => {
    mocks.rows = [
      request({
        id: "leg-1", seriesId: "series-1", seriesIndex: 1, seriesCount: 3,
        departAt: "2026-09-15T08:00:00+03:00", returnAt: "2026-09-15T23:59:00+03:00",
      }),
      request({
        id: "leg-2", seriesId: "series-1", seriesIndex: 2, seriesCount: 3,
        departAt: "2026-09-16T00:00:00+03:00", returnAt: "2026-09-16T23:59:00+03:00",
      }),
      request({
        id: "leg-3", seriesId: "series-1", seriesIndex: 3, seriesCount: 3,
        departAt: "2026-09-17T00:00:00+03:00", returnAt: "2026-09-17T12:00:00+03:00",
      }),
    ];
    show();
    expect(screen.getAllByText(he.status.submitted)).toHaveLength(1);
    expect(screen.getByText(tv("request.multiDayBadge", { count: "3" }))).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: he.requestsList.edit })).not.toBeInTheDocument();
  });

  it("hides make-repeating for a multi-day request's card", () => {
    mocks.rows = [
      request({ id: "leg-1", seriesId: "series-1", seriesIndex: 1, seriesCount: 2, status: "submitted", templateId: null }),
      request({ id: "leg-2", seriesId: "series-1", seriesIndex: 2, seriesCount: 2, status: "submitted", templateId: null }),
    ];
    show();
    expect(screen.queryByRole("button", { name: he.request.makeRepeating })).not.toBeInTheDocument();
  });
});
