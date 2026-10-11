import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WeekGridProps } from "@/components/WeekGrid";
import type { BoardRide, Week } from "@/features/siddur/api";

import { MyWeekView } from "./MyWeekView";

// Owner 2026-10-11: my own rides drag on "my rides" exactly as on the siddur — the same `useMemberRideMoves` — but only
// within the ride's own day (the columns are days), on its own car.
const mocks = vi.hoisted(() => ({
  grid: { current: null as WeekGridProps | null },
  moveRide: vi.fn(),
  isValidTarget: vi.fn(() => true),
  owns: vi.fn(() => true),
}));

vi.mock("@/components/WeekGrid", () => ({
  WeekGrid: (props: WeekGridProps) => { mocks.grid.current = props; return null; },
}));
vi.mock("@/features/siddur/hooks", () => ({ useBoardRides: () => ({ data: [ride], isError: false }) }));
vi.mock("@/features/fleet/hooks", () => ({ useCars: () => ({ data: [{ id: "car1", name: "קורולה" }] }) }));
vi.mock("@/features/sadran/hooks", () => ({ useDepartmentSettings: () => ({ data: { board_start_time: "06:00:00" } }) }));
vi.mock("../hooks", () => ({ useTemplateSuggestionsQuery: () => ({ data: [] }) }));
vi.mock("@/components/dateFieldDates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/dateFieldDates")>()),
  todayInJerusalem: () => "2026-10-12",
}));
vi.mock("@/features/rides/useMemberRideMoves", () => ({
  useMemberRideMoves: () => ({
    ownsEditableRide: mocks.owns, moveRide: mocks.moveRide, isValidTarget: mocks.isValidTarget, saving: false,
    collisionDialog: { open: false, onOpenChange: vi.fn(), title: "", description: "", confirmLabel: "", loading: false, onConfirm: vi.fn() },
  }),
}));

const ride = {
  id: "ride1", status: "confirmed", car_id: "car1", driver_id: "me", starts_at: "2026-10-13T05:00:00Z", ends_at: "2026-10-13T08:00:00Z",
  served: [], passengers: [], destination_name: "חיפה", origin_name: "נבו", origin_id: "o", destination_id: "d",
} as unknown as BoardRide;
const weeks = [{ week_start: "2026-10-11", phase: "published" }] as Week[];

function grid(): WeekGridProps {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <MyWeekView departmentId="dept" homeDestinationId="home" profileId="me" requests={[]} weeks={weeks} homeWeekStart="2026-10-11" canSubmit onTarget={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return mocks.grid.current!;
}

describe("MyWeekView dragging my rides", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.owns.mockReturnValue(true); });

  it("lets me drag and resize my own ride; other blocks stay put", () => {
    const props = grid();
    expect(props.readOnly).toBe(false);
    expect(props.draggable).toBe(true);
    const block = props.rides.find((r) => r.id === "ride:ride1")!;
    expect(props.canDragRide?.(block)).toBe(true);
    expect(props.canResizeRide?.(block)).toBe(true);
    expect(props.canDragRide?.({ ...block, id: "request:r1" })).toBe(false);
    mocks.owns.mockReturnValue(false);
    expect(props.canDragRide?.(block)).toBe(false);
  });

  it("moves within the ride's own day on its own car; another day is refused", () => {
    const props = grid();
    expect(props.isDropTargetValid?.("ride:ride1", "2026-10-13", 600, 780)).toBe(true);
    expect(mocks.isValidTarget).toHaveBeenLastCalledWith("ride1", "car1", 600, 780);
    expect(props.isDropTargetValid?.("ride:ride1", "2026-10-14", 600, 780)).toBe(false);
    props.onRideDrop?.("ride:ride1", "2026-10-14", 600);
    expect(mocks.moveRide).not.toHaveBeenCalled();
    props.onRideDrop?.("ride:ride1", "2026-10-13", 600);
    expect(mocks.moveRide).toHaveBeenCalledWith("ride1", "car1", 600);
    // Ride 08:00-11:00 Jerusalem; pulling its end to 12:00 keeps the start.
    props.onRideResize?.("ride:ride1", "end", 720);
    expect(mocks.moveRide).toHaveBeenLastCalledWith("ride1", "car1", 480, 720);
  });
});
