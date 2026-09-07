import { describe, expect, it } from "vitest";
import type { WeekRequestRow } from "../api";
import { packPhantomLanes, requestStart, requestWindow, requestWithinFlex } from "./phantomLanes";

const request = {
  trip_shape: "round_trip", depart_at: "2026-09-10T07:00:00Z", return_at: "2026-09-10T09:00:00Z",
  flex_depart_early: "01:00:00", flex_depart_late: "01:00:00", flex_return_early: "01:00:00", flex_return_late: "01:00:00",
  destination_travel_minutes: 40,
} as WeekRequestRow;

describe("unmet intervals", () => {
  it("uses exactly the concurrent lane count and reuses released lanes deterministically", () => {
    const packed = packPhantomLanes([
      { id: "c", startMinutes: 720, endMinutes: 800 },
      { id: "b", startMinutes: 600, endMinutes: 720 },
      { id: "a", startMinutes: 600, endMinutes: 720 },
    ]);
    expect(packed.map(({ id, lane }) => ({ id, lane }))).toEqual([{ id: "a", lane: 0 }, { id: "b", lane: 1 }, { id: "c", lane: 0 }]);
  });

  it("anchors return-only requests to arrival and shows the preceding journey", () => {
    const returning = { ...request, trip_shape: "one_way_from" as const, depart_at: null };
    expect(requestStart(returning)).toBe(request.return_at);
    expect(requestWindow(returning)).toEqual({ startsAt: "2026-09-10T08:15:00.000Z", endsAt: request.return_at });
  });

  it("shows an outbound journey without needing a return timestamp", () => {
    expect(requestWindow({ ...request, trip_shape: "one_way_to", return_at: null })).toEqual({ startsAt: request.depart_at, endsAt: "2026-09-10T07:45:00.000Z" });
  });
});

describe("original request flexibility", () => {
  it("does not accumulate another hour of flexibility after the first move", () => {
    expect(requestWithinFlex(request, "2026-09-10T08:00:00Z", "2026-09-10T10:00:00Z")).toBe(true);
    expect(requestWithinFlex(request, "2026-09-10T09:00:00Z", "2026-09-10T11:00:00Z")).toBe(false);
  });
  it("validates the resized end independently of the unchanged start", () => {
    expect(requestWithinFlex(request, request.depart_at!, "2026-09-10T10:00:00Z")).toBe(true);
    expect(requestWithinFlex(request, request.depart_at!, "2026-09-10T10:15:00Z")).toBe(false);
  });
  it("validates arrival time for return-only requests", () => {
    expect(requestWithinFlex({ ...request, trip_shape: "one_way_from", depart_at: null }, "2026-09-10T09:15:00Z", "2026-09-10T10:00:00Z")).toBe(true);
  });
});
