import { describe, expect, it } from "vitest";

import type { MyRequestRow } from "./api";
import { toDisplayRows } from "./myRequestsRows";
import { buildTripWeeks, ridesByRequestRow, type TripRide } from "./myTrips";

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

interface Ride extends TripRide { requestIds: string[] }
const ride = (id: string, startsAt: string, requestIds: string[], weekStart = "2026-10-11"): Ride =>
  ({ id, starts_at: startsAt, week_start: weekStart, department_id: "dept-1", requestIds });
const idsOf = (r: Ride) => r.requestIds;

describe("buildTripWeeks (owner 2026-10-13: one item per trip)", () => {
  it("attaches a ride to the request it serves instead of listing it twice", () => {
    const rows = toDisplayRows([request()]);
    const weeks = buildTripWeeks(rows, [], [ride("r1", "2026-10-12T08:00:00+03:00", ["request-1"])], idsOf);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.items).toEqual([{ kind: "request", row: rows[0], rides: [expect.objectContaining({ id: "r1" })] }]);
  });

  it("lists a ride none of my requests reaches as its own item, in time order, also in a week with no request", () => {
    const rows = toDisplayRows([request()]);
    const weeks = buildTripWeeks(rows, [], [
      ride("other", "2026-10-12T07:00:00+03:00", ["someone-else"]),
      ride("next-week", "2026-10-19T09:00:00+03:00", [], "2026-10-18"),
    ], idsOf);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-10-11", "2026-10-18"]);
    expect(weeks[0]!.items.map((item) => item.kind)).toEqual(["ride", "request"]);
    expect(weeks[1]!.rows).toEqual([]);
    expect(weeks[1]!.items).toEqual([{ kind: "ride", ride: expect.objectContaining({ id: "next-week" }) }]);
  });

  it("never lists a ride of a request shown elsewhere on the page (the unserved section)", () => {
    const unserved = toDisplayRows([request({ id: "request-2", status: "waitlisted" })]);
    const weeks = buildTripWeeks([], unserved, [ride("r2", "2026-10-12T08:00:00+03:00", ["request-2"])], idsOf);
    expect(weeks).toEqual([]);
  });

  it("a multi-day series carries only its next ride", () => {
    const legs = ["2026-10-12", "2026-10-13"].map((day, index) => request({
      id: `leg-${index}`, seriesId: "s1", seriesIndex: index + 1, seriesCount: 2,
      departAt: `${day}T08:00:00+03:00`, returnAt: `${day}T23:59:00+03:00`,
    }));
    const rows = toDisplayRows(legs);
    const map = ridesByRequestRow(rows, [
      ride("day2", "2026-10-13T08:00:00+03:00", ["leg-1"]),
      ride("day1", "2026-10-12T08:00:00+03:00", ["leg-0"]),
    ], idsOf);
    expect(map.get(rows[0]!.id)?.map((r) => r.id)).toEqual(["day1"]);
  });
});
