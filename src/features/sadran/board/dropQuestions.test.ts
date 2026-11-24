import { describe, expect, it } from "vitest";

import { guestDropQuestion, movedPastStopHour, rideDropAsksMerge, splitOutcome } from "./dropQuestions";

const host = { id: "h", car_id: "c1", status: "confirmed", driver_id: "d", needs_driver: false };
const base = { ride: { id: "r", needs_driver: false }, host, droppedOnRideId: "h", carId: "c1", draggedServesRequest: true, hostIsReservation: false, isPlanningChange: false };

describe("rideDropAsksMerge", () => {
  it("asks when a ride with a driver lands on another ride of the car", () => {
    expect(rideDropAsksMerge(base)).toBe(true);
  });
  it("stays a plain move on empty space, itself, another car, a cancelled or driverless host", () => {
    expect(rideDropAsksMerge({ ...base, droppedOnRideId: undefined })).toBe(false);
    expect(rideDropAsksMerge({ ...base, droppedOnRideId: "r" })).toBe(false);
    expect(rideDropAsksMerge({ ...base, carId: "c2" })).toBe(false);
    expect(rideDropAsksMerge({ ...base, host: { ...host, status: "cancelled" } })).toBe(false);
    expect(rideDropAsksMerge({ ...base, host: { ...host, needs_driver: true } })).toBe(false);
    expect(rideDropAsksMerge({ ...base, host: undefined })).toBe(false);
  });
  it("does not ask for a reservation, a needs-driver ride, a ride with no request or a planning shadow", () => {
    expect(rideDropAsksMerge({ ...base, hostIsReservation: true })).toBe(false);
    expect(rideDropAsksMerge({ ...base, ride: { id: "r", needs_driver: true } })).toBe(false);
    expect(rideDropAsksMerge({ ...base, draggedServesRequest: false })).toBe(false);
    expect(rideDropAsksMerge({ ...base, isPlanningChange: true })).toBe(false);
  });
});

describe("guestDropQuestion", () => {
  it("transfers to another live ride, splits otherwise", () => {
    expect(guestDropQuestion({ guestRideId: "a", hostRideId: "b", hostIsLiveRide: true })).toBe("transfer");
    expect(guestDropQuestion({ guestRideId: "a", hostRideId: "a", hostIsLiveRide: true })).toBe("split");
    expect(guestDropQuestion({ guestRideId: "a", hostRideId: undefined, hostIsLiveRide: false })).toBe("split");
    expect(guestDropQuestion({ guestRideId: "a", hostRideId: "draft:x", hostIsLiveRide: false })).toBe("split");
  });
});

describe("splitOutcome", () => {
  const ride = { starts_at: "2042-01-19T05:45:00Z", ends_at: "2042-01-19T09:15:00Z" };
  it("shrinks toward the base request's own hours", () => {
    const out = splitOutcome(ride, { depart_at: "2042-01-19T06:00:00Z", return_at: "2042-01-19T09:00:00Z" });
    expect(out.afterStart).toBe("2042-01-19T06:00:00.000Z");
    expect(out.afterEnd).toBe("2042-01-19T09:00:00.000Z");
  });
  it("reports no change when the ride already matches or the base times are unknown", () => {
    expect(splitOutcome(ride, { depart_at: ride.starts_at, return_at: ride.ends_at }).afterStart).toBeNull();
    expect(splitOutcome(ride, undefined).afterEnd).toBeNull();
  });
  it("never grows the ride", () => {
    const out = splitOutcome(ride, { depart_at: "2042-01-19T05:00:00Z", return_at: "2042-01-19T10:00:00Z" });
    expect(out.afterStart).toBeNull();
  });
});

describe("movedPastStopHour (silent drops item 5)", () => {
  const t = (hhmm: string) => `2042-02-18T${hhmm}:00.000Z`;
  const request = {
    requester_full_name: "Noa", depart_at: t("07:00"), return_at: t("17:00"),
    stops: [
      { leg: "out" as const, position: 1, fixed_anchor: "arrive" as const, fixed_at: t("08:00"), flex_minutes: 15, place: { name: "Zichron" } },
      { leg: "return" as const, position: 1, fixed_anchor: "leave" as const, fixed_at: t("16:00"), flex_minutes: 0, place_text: "School" },
    ],
  };
  const ride = { startsAt: t("07:00"), endsAt: t("17:00") };

  it("a later start past the arrive-by flexibility asks, with the estimate after the move", () => {
    expect(movedPastStopHour(request, "out", ride, { startsAt: t("07:30"), endsAt: t("17:30") }))
      .toEqual({ name: "Noa", place: "Zichron", anchor: "arrive", at: t("08:00"), newAt: t("08:30") });
  });
  it("within the flexibility, or earlier for an arrive-by, does not ask", () => {
    expect(movedPastStopHour(request, "out", ride, { startsAt: t("07:15"), endsAt: t("17:15") })).toBeNull();
    expect(movedPastStopHour(request, "out", ride, { startsAt: t("06:00"), endsAt: t("16:00") })).toBeNull();
  });
  it("a leave-at breaks either way; only the legs the ride carries count", () => {
    expect(movedPastStopHour(request, "both", ride, { startsAt: t("07:00"), endsAt: t("16:45") })?.place).toBe("School");
    expect(movedPastStopHour(request, "out", ride, { startsAt: t("07:00"), endsAt: t("16:45") })).toBeNull();
  });
  it("a move that brings a broken hour closer does not ask", () => {
    const late = { startsAt: t("08:00"), endsAt: t("17:00") };
    expect(movedPastStopHour(request, "out", late, { startsAt: t("07:45"), endsAt: t("17:00") })).toBeNull();
  });
});
