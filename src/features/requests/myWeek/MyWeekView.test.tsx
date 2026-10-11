import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardRide, Week } from "@/features/siddur/api";

import type { MyRequestRow } from "../api";
import { MyWeekView } from "./MyWeekView";

vi.mock("@/features/siddur/hooks", () => ({
  useBoardRides: () => ({ data: [ride], isError: false }),
}));
vi.mock("@/features/fleet/hooks", () => ({ useCars: () => ({ data: [{ id: "car1", name: "קורולה" }] }) }));
vi.mock("@/features/sadran/hooks", () => ({ useDepartmentSettings: () => ({ data: { board_start_time: "06:00:00" } }) }));
vi.mock("../hooks", () => ({ useTemplateSuggestionsQuery: () => ({ data: [] }) }));
vi.mock("@/features/rides/useMemberRideMoves", () => ({
  useMemberRideMoves: () => ({
    ownsEditableRide: () => true, moveRide: vi.fn(), isValidTarget: () => true, saving: false,
    collisionDialog: { open: false, onOpenChange: vi.fn(), title: "", description: "", confirmLabel: "", loading: false, onConfirm: vi.fn() },
  }),
}));
vi.mock("@/components/dateFieldDates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/dateFieldDates")>()),
  todayInJerusalem: () => "2026-10-12",
}));

const ride = {
  id: "ride1", status: "confirmed", car_id: "car1", driver_id: "me", starts_at: "2026-10-13T05:00:00Z", ends_at: "2026-10-13T08:00:00Z",
  served: [], passengers: [], destination_name: "חיפה", origin_name: "נבו", origin_id: "o", destination_id: "d",
} as unknown as BoardRide;

const request = {
  id: "r1", departmentId: "dept", weekStart: "2026-10-11", status: "submitted", statusReason: null,
  departAt: "2026-10-13T06:00:00Z", returnAt: "2026-10-13T09:00:00Z", tripType: "round_trip", destination: "עכו",
  originId: null, originText: null, originName: null, stops: [], legs: [], ride: null, pendingProposal: null,
  seriesId: null, seriesIndex: null, seriesCount: null,
} as unknown as MyRequestRow;

const weeks = [{ week_start: "2026-10-11", phase: "published" }, { week_start: "2026-10-18", phase: "open" }] as Week[];

function renderView(onTarget = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <MyWeekView departmentId="dept" homeDestinationId="home" profileId="me" requests={[request]} weeks={weeks} homeWeekStart="2026-10-11" canSubmit onTarget={onTarget} />
    </MemoryRouter>
    </QueryClientProvider>,
  );
  return onTarget;
}

describe("MyWeekView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("draws seven day columns, my ride with its car, and my request side by side on the same day", () => {
    renderView();
    expect(screen.getAllByTestId("week-grid-car-name")).toHaveLength(7);
    const rideBlock = document.querySelector('[data-ride-id="ride:ride1"]');
    const requestBlock = document.querySelector('[data-ride-id="request:r1"]');
    expect(rideBlock?.textContent).toContain("קורולה");
    expect(requestBlock?.getAttribute("data-kind")).toBe("request");
    // 08:00-11:00 ride and 09:00-12:00 request overlap on Tuesday: two lanes each.
    expect((rideBlock as HTMLElement).style.width).toContain("50%");
    expect((requestBlock as HTMLElement).style.width).toContain("50%");
  });

  it("hands a tapped block's own item to the page", () => {
    const onTarget = renderView();
    fireEvent.click(document.querySelector('[data-ride-id="ride:ride1"]') as HTMLElement);
    expect(onTarget).toHaveBeenCalledWith(expect.objectContaining({ type: "ride" }));
    fireEvent.click(document.querySelector('[data-ride-id="request:r1"]') as HTMLElement);
    expect(onTarget).toHaveBeenCalledWith(expect.objectContaining({ type: "request" }));
  });
});
