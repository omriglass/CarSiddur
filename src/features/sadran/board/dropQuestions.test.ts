import { describe, expect, it } from "vitest";

import { guestDropQuestion, rideDropAsksMerge, splitOutcome } from "./dropQuestions";

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
