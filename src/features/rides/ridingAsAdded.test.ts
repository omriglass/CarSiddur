import { describe, expect, it } from "vitest";

import { requestsRidingAsAdded } from "./ridingAsAdded";

const added = (personId: string) => ({
  key: `added:${personId}`, source: "added", request_id: null, ride_passenger_id: "rp", person_id: personId, child_id: null,
  display_name: "נוסעת", seat_kind: "adult", added_by: null, removable: true,
});
const ride = (over: Partial<{ id: string; status: string; people: unknown[] }> = {}) => ({
  id: "ride-1", status: "confirmed", starts_at: "2046-01-08T06:15:00Z", ends_at: "2046-01-08T12:45:00Z", driver_name: "נהג", people: [added("m1")],
  ...over,
}) as never;
const request = (over: Partial<{ id: string; status: string; depart_at: string | null; return_at: string | null; requester_id: string }> = {}) => ({
  id: "q1", requester_id: "m1", status: "waitlisted", depart_at: "2046-01-08T06:30:00Z", return_at: "2046-01-08T12:00:00Z", ...over,
});

describe("requestsRidingAsAdded (PS1)", () => {
  it("finds an unplaced request whose person rides as an added passenger at those hours", () => {
    expect(requestsRidingAsAdded([request()], [ride()]).get("q1")).toMatchObject({ rideId: "ride-1", driverName: "נהג" });
  });
  it("ignores other hours, other people, placed requests and cancelled rides", () => {
    expect(requestsRidingAsAdded([request({ depart_at: "2046-01-08T14:00:00Z", return_at: "2046-01-08T15:00:00Z" })], [ride()]).size).toBe(0);
    expect(requestsRidingAsAdded([request({ requester_id: "m2" })], [ride()]).size).toBe(0);
    expect(requestsRidingAsAdded([request({ status: "merged" })], [ride()]).size).toBe(0);
    expect(requestsRidingAsAdded([request()], [ride({ status: "cancelled" })]).size).toBe(0);
  });
  it("a request's own seat (a requester row, not added) does not count", () => {
    expect(requestsRidingAsAdded([request()], [ride({ people: [{ ...added("m1"), key: "req:q9", source: "requester", request_id: "q9" }] })]).size).toBe(0);
  });
});
