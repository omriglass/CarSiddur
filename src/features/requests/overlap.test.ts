import { describe, expect, it } from "vitest";

import { canPlaceOnOwnCar, isDuplicateWithdrawn, overlapCancelAction } from "./overlap";

describe("overlapCancelAction", () => {
  it("cancels the ride when the other request has one", () => {
    const ride = { id: "r1", version: 3, status: "confirmed" } as never;
    expect(overlapCancelAction({ id: "q", version: 1, ride })).toEqual({ kind: "cancelRide", rideId: "r1", expectedVersion: 3 });
  });
  it("withdraws a request with no ride", () => {
    expect(overlapCancelAction({ id: "q", version: 2, ride: null })).toEqual({ kind: "withdraw", requestId: "q", expectedVersion: 2 });
  });
});

describe("canPlaceOnOwnCar", () => {
  const row = { status: "waitlisted", tripType: "round_trip", ride: null } as const;
  it("needs an own car and an unserved round trip", () => {
    expect(canPlaceOnOwnCar(row, 1)).toBe(true);
    expect(canPlaceOnOwnCar(row, 0)).toBe(false);
    expect(canPlaceOnOwnCar({ ...row, tripType: "one_way" }, 1)).toBe(false);
    expect(canPlaceOnOwnCar({ ...row, status: "assigned" }, 1)).toBe(false);
  });
});

describe("isDuplicateWithdrawn", () => {
  it("matches only a withdrawn request with the duplicate reason", () => {
    expect(isDuplicateWithdrawn({ status: "withdrawn", statusReason: "DUPLICATE_WITHDRAWN" })).toBe(true);
    expect(isDuplicateWithdrawn({ status: "withdrawn", statusReason: "WITHDRAWN_BY_MEMBER" })).toBe(false);
  });
});
