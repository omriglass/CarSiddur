import { describe, expect, it } from "vitest";

import { fitsJoinWindow, groupJoinWindow, groupSummaryItems, myJoinableRequest } from "./summary";
import type { WaitlistGroup, WaitlistGroupMember } from "./types";

const member = (over: Partial<WaitlistGroupMember>): WaitlistGroupMember => ({
  request_id: "r", profile_id: "p", name: "שחר", depart_at: "2026-10-29T09:00:00+02:00", return_at: "2026-10-29T13:00:00+02:00",
  adults: 1, child_seats: 0, boosters: 0, destination: "בנימינה", companions: [], chosen: null, ...over,
});

const group: WaitlistGroup = {
  id: "g", department_id: "d", week_start: "2026-10-25", day: "2026-10-29",
  starts_at: "2026-10-29T09:00:00+02:00", ends_at: "2026-10-29T15:00:00+02:00", status: "open", ride_id: null,
  resolved_by: null, resolved_at: null, version: 1, created_at: "", updated_at: "",
  members: [member({ request_id: "a", profile_id: "pa" })],
};

describe("groupSummaryItems", () => {
  it("lists each undecided member with companions, destination and hours", () => {
    const items = groupSummaryItems([
      member({ request_id: "a", companions: ["עמוס"] }),
      member({ request_id: "b", name: "ענת", destination: "שדה יצחק", depart_at: "2026-10-29T10:00:00+02:00", return_at: "2026-10-29T14:00:00+02:00" }),
      member({ request_id: "c", name: "יעל", chosen: false }),
    ]);
    expect(items).toEqual([
      { requestId: "a", who: "שחר עם עמוס", destination: "בנימינה", start: "09:00", end: "13:00" },
      { requestId: "b", who: "ענת", destination: "שדה יצחק", start: "10:00", end: "14:00" },
    ]);
  });
});

describe("groupJoinWindow", () => {
  it("spans every held car's free gap; null when the group holds none", () => {
    const hold = (car: string, from: string, until: string) => ({ group_id: "g", car_id: car, held_from: from, held_until: until, gap_from: from, gap_until: until });
    expect(groupJoinWindow("g", [hold("c1", "2026-10-29T08:00:00Z", "2026-10-29T12:00:00Z"), hold("c2", "2026-10-29T07:00:00Z", "2026-10-29T11:00:00Z")]))
      .toEqual({ from: "2026-10-29T07:00:00Z", until: "2026-10-29T12:00:00Z" });
    expect(groupJoinWindow("other", [hold("c1", "2026-10-29T08:00:00Z", "2026-10-29T12:00:00Z")])).toBeNull();
  });
});

describe("fitsJoinWindow", () => {
  const window = { from: "2026-10-29T08:00:00+02:00", until: "2026-10-29T18:00:00+02:00" };
  it("needs the hours inside the free gap and overlapping the discussion", () => {
    expect(fitsJoinWindow("2026-10-29T10:00:00+02:00", "2026-10-29T12:00:00+02:00", group, window)).toBe(true);
    expect(fitsJoinWindow("2026-10-29T07:00:00+02:00", "2026-10-29T12:00:00+02:00", group, window)).toBe(false);
    expect(fitsJoinWindow("2026-10-29T15:30:00+02:00", "2026-10-29T17:00:00+02:00", group, window)).toBe(false);
    expect(fitsJoinWindow(null, "2026-10-29T12:00:00+02:00", group, window)).toBe(false);
  });
});

describe("myJoinableRequest", () => {
  const request = { id: "x", requesterId: "me", status: "waitlisted", statusReason: "WAITLISTED_NO_CAR",
    departAt: "2026-10-29T10:00:00+02:00", returnAt: "2026-10-29T12:00:00+02:00", weekStart: "2026-10-25" };
  it("finds my overlapping waiting request, not one already in a discussion or of a member", () => {
    expect(myJoinableRequest(group, [request], "me")?.id).toBe("x");
    expect(myJoinableRequest(group, [{ ...request, statusReason: "WAITLISTED_CONTESTED" }], "me")).toBeNull();
    expect(myJoinableRequest(group, [{ ...request, departAt: "2026-10-29T16:00:00+02:00", returnAt: "2026-10-29T17:00:00+02:00" }], "me")).toBeNull();
    expect(myJoinableRequest(group, [request], "pa")).toBeNull();
  });
});
