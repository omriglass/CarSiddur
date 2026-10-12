import { describe, expect, it } from "vitest";

import type { RequestEditRow } from "../api";
import { movedRequestPayload } from "./requestMove";

// 2026-10-11 is a Sunday; Jerusalem is UTC+3 in October.
function row(overrides: Partial<RequestEditRow> = {}): RequestEditRow {
  return {
    requesterId: "member-1", requesterName: null, filedById: null, preferredCarId: null,
    id: "req-1", departmentId: "dept-1", weekStart: "2026-10-11", status: "submitted", version: 4,
    destinationId: "dest-haifa", destinationText: null, destinationName: "חיפה", rideTypeId: "rt-1",
    tripShape: "round_trip", originId: "home", originText: null, originName: "הבית",
    outStops: [], returnStops: [], tripType: "round_trip",
    departAt: "2026-10-13T06:00:00Z", returnAt: "2026-10-13T10:00:00Z", keptReturnAt: null,
    departAnchor: "arrive", arriveBy: "2026-10-13T07:00:00Z", returnAnchor: "leave", leaveDestAt: "2026-10-13T09:00:00Z",
    durationLocked: false, fallback: "none", servedByAlternative: false, alternative: null,
    oneWayCarMode: null, needsCarAtDestination: true, adults: 2, childSeats: 1, boosters: 0, hasLuggage: false,
    flexDepartEarly: "00:30:00", flexDepartLate: "00:00:00", flexReturnEarly: "00:00:00", flexReturnLate: "01:00:00",
    notes: "with the dog", rideDescription: null, guestPassengerNames: ["Dana"], changedSinceSolve: false, templateId: null,
    ...overrides,
  };
}

describe("movedRequestPayload", () => {
  it("moves the whole request to another day, keeping everything else as stored", () => {
    const payload = movedRequestPayload(row(), "2026-10-11", { day: "2026-10-15", departMinutes: 10 * 60, returnMinutes: 14 * 60 });
    expect(payload).toMatchObject({
      request_id: "req-1",
      expected_version: 4,
      department_id: "dept-1",
      week_start: "2026-10-11",
      depart_at: "2026-10-15T07:00:00.000Z",
      return_at: "2026-10-15T11:00:00.000Z",
      destination_id: "dest-haifa",
      origin_id: "home",
      trip_type: "round_trip",
      adults: 2,
      child_seats: 1,
      notes: "with the dog",
      flex_depart_early: "00:30:00",
      flex_return_late: "01:00:00",
      stops: [],
    });
  });

  it("leaves the entered anchors and the people out, so the server keeps and shifts them", () => {
    // What goes over the wire: `undefined` keys are dropped by JSON.
    const payload = JSON.parse(JSON.stringify(movedRequestPayload(row(), "2026-10-11", { day: "2026-10-13", departMinutes: 10 * 60, returnMinutes: null }))) as Record<string, unknown>;
    for (const key of ["depart_anchor", "arrive_by", "return_anchor", "leave_dest_at", "duration_locked", "guest_passenger_names", "requester_id", "companion_ids"]) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it("a resize changes one end only", () => {
    const payload = movedRequestPayload(row(), "2026-10-11", { day: "2026-10-13", departMinutes: null, returnMinutes: 15 * 60 });
    expect(payload.depart_at).toBe("2026-10-13T06:00:00.000Z");
    expect(payload.return_at).toBe("2026-10-13T12:00:00.000Z");
  });

  it("a return at midnight is the last minute of the day", () => {
    const payload = movedRequestPayload(row(), "2026-10-11", { day: "2026-10-13", departMinutes: null, returnMinutes: 24 * 60 });
    expect(payload.return_at).toBe("2026-10-13T20:59:00.000Z");
  });

  it("a one-way request moves its only time", () => {
    const payload = movedRequestPayload(row({ tripShape: "one_way_to", tripType: "one_way", returnAt: null }), "2026-10-11", { day: "2026-10-14", departMinutes: 8 * 60, returnMinutes: null });
    expect(payload.depart_at).toBe("2026-10-14T05:00:00.000Z");
    expect(payload.return_at).toBeUndefined();
  });
});
