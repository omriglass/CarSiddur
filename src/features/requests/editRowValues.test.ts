import { describe, expect, it } from "vitest";

import type { RequestEditRow } from "./api";
import { editRowToFormValues } from "./editRowValues";

// 2026-10-11 is a Sunday; Jerusalem is UTC+3 in October (until the 25th).
function row(overrides: Partial<RequestEditRow> = {}): RequestEditRow {
  return {
    requesterId: "member-1", requesterName: null, filedById: null, preferredCarId: null,
    id: "req-1", departmentId: "dept-1", weekStart: "2026-10-11", status: "submitted", version: 4,
    destinationId: "dest-haifa", destinationText: null, destinationName: "חיפה", rideTypeId: "rt-1",
    tripShape: "round_trip", originId: "home", originText: null, originName: "הבית",
    outStops: [], returnStops: [], tripType: "round_trip",
    departAt: "2026-10-13T06:00:00Z", returnAt: "2026-10-13T20:59:00Z", keptReturnAt: null,
    departAnchor: "leave", arriveBy: null, returnAnchor: "arrive", leaveDestAt: null,
    durationLocked: false, fallback: "none", servedByAlternative: false, alternative: null,
    oneWayCarMode: null, needsCarAtDestination: true, adults: 1, childSeats: 0, boosters: 0, hasLuggage: false,
    flexDepartEarly: "00:00:00", flexDepartLate: "00:00:00", flexReturnEarly: "00:00:00", flexReturnLate: "00:00:00",
    notes: null, rideDescription: null, guestPassengerNames: [], changedSinceSolve: false, templateId: null,
    ...overrides,
  };
}

describe("editRowToFormValues", () => {
  it("reopens a single-day request on its own day", () => {
    const values = editRowToFormValues(row({ returnAt: "2026-10-13T14:00:00Z" }), "2026-10-11", [], [], 0, 0);
    expect(values).toMatchObject({ day: "2026-10-13", returnDay: "2026-10-13", departTime: "09:00", returnTime: "17:00" });
  });

  it("reopens a multi-day request over its whole span (REQ §13.142)", () => {
    const values = editRowToFormValues(row({ seriesId: "s1", seriesReturnAt: "2026-10-15T15:00:00Z" }), "2026-10-11", [], [], 0, 0);
    expect(values).toMatchObject({ day: "2026-10-13", returnDay: "2026-10-15", departTime: "09:00", returnTime: "18:00" });
  });
});
