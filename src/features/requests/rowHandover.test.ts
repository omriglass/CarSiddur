import { describe, expect, it } from "vitest";

import type { CarNeighbour, CarNeighbours } from "@/features/rides/carHandover";
import type { MyRequestRow, MyRequestRide } from "./api";
import { toDisplayRows } from "./myRequestsRows";
import { rowHandover, rowHandoverRideIds } from "./rowHandover";

function ride(id: string, startsAt: string, endsAt: string, overrides: Partial<MyRequestRide> = {}): MyRequestRide {
  return { id, startsAt, endsAt, status: "confirmed", originName: "Home", destinationName: "Home", carName: "Car", carType: "shared", driverName: "Me", isChauffeur: false, role: "driver", ...overrides };
}
function request(overrides: Partial<MyRequestRow> = {}): MyRequestRow {
  return {
    id: "request-1", departmentId: "dept-1", weekStart: "2026-10-11", status: "assigned",
    statusReason: null, isLate: false, changedSinceSolve: false, departAt: "2026-10-12T08:00:00+03:00",
    returnAt: "2026-10-12T10:00:00+03:00", tripShape: "round_trip", destination: "Destination",
    originId: null, originText: null, originName: null, stops: [], tripType: "round_trip",
    rideTypeId: "type-1", rideTypeName: "Type", rideTypeCode: null, needsCarAtDestination: true,
    version: 1, freedSlotOptOut: false, ride: null, pendingProposal: null, templateId: null,
    seriesId: null, seriesIndex: null, seriesCount: null, window: null,
    ...overrides,
  };
}
const neighbour = (rideId: string, over: Partial<CarNeighbour> = {}): CarNeighbour =>
  ({ rideId, at: "2026-10-12T10:30:00+03:00", kind: "ride", name: "Dana", people: ["other"], gapMinutes: 30, tight: true, ...over });

describe("rowHandover", () => {
  it("builds the note for a single-ride row", () => {
    const [row] = toDisplayRows([request({ ride: ride("r1", "2026-10-12T08:00:00+03:00", "2026-10-12T10:00:00+03:00") })]);
    const map = new Map<string, CarNeighbours>([["r1", { next: neighbour("n"), prev: null }]]);
    const result = rowHandover(row!, map, "me");
    expect(result?.notes.returnBy?.rideId).toBe("n");
    expect(result?.span).toEqual({ startsAt: "2026-10-12T08:00:00+03:00", endsAt: "2026-10-12T10:00:00+03:00" });
  });

  it("returns null with no tight neighbour, no viewer, or no ride", () => {
    const [row] = toDisplayRows([request({ ride: ride("r1", "2026-10-12T08:00:00+03:00", "2026-10-12T10:00:00+03:00") })]);
    const loose = new Map<string, CarNeighbours>([["r1", { next: neighbour("n", { tight: false }), prev: null }]]);
    expect(rowHandover(row!, loose, "me")).toBeNull();
    expect(rowHandover(row!, new Map([["r1", { next: neighbour("n"), prev: null }]]), undefined)).toBeNull();
    expect(rowHandover(toDisplayRows([request()])[0]!, new Map(), "me")).toBeNull();
  });

  it("a multi-day row uses the last leg's ride for next and the first leg's for prev", () => {
    const rows = toDisplayRows([
      request({ id: "l1", seriesId: "s", seriesIndex: 1, seriesCount: 2, ride: ride("r1", "2026-10-12T08:00:00+03:00", "2026-10-12T10:00:00+03:00") }),
      request({ id: "l2", seriesId: "s", seriesIndex: 2, seriesCount: 2, departAt: "2026-10-13T08:00:00+03:00", returnAt: "2026-10-13T10:00:00+03:00", ride: ride("r2", "2026-10-13T08:00:00+03:00", "2026-10-13T10:00:00+03:00") }),
    ]);
    expect(rowHandoverRideIds(rows).sort()).toEqual(["r1", "r2"]);
    const map = new Map<string, CarNeighbours>([
      ["r1", { next: neighbour("first-next"), prev: neighbour("first-prev") }],
      ["r2", { next: neighbour("last-next"), prev: neighbour("last-prev") }],
    ]);
    const result = rowHandover(rows[0]!, map, "me");
    expect(result?.notes.returnBy?.rideId).toBe("last-next");
    expect(result?.notes.arrivesFrom?.rideId).toBe("first-prev");
    expect(result?.span).toEqual({ startsAt: "2026-10-12T08:00:00+03:00", endsAt: "2026-10-13T10:00:00+03:00" });
  });

  it("skips cancelled rides when collecting ids", () => {
    const rows = toDisplayRows([request({ ride: ride("r1", "2026-10-12T08:00:00+03:00", "2026-10-12T10:00:00+03:00", { status: "cancelled" }) })]);
    expect(rowHandoverRideIds(rows)).toEqual([]);
  });
});
