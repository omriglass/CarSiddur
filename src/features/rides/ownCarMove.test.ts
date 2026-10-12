import { describe, expect, it } from "vitest";

import { canMoveOntoMyCar, ownCarMoveTargets } from "./ownCarMove";

const now = new Date("2026-10-12T08:00:00Z");
const ride = (over: Record<string, unknown> = {}) => ({ id: "r", version: 1, car_id: "shared", starts_at: "2026-10-12T10:00:00Z", status: "confirmed", served: [{ request_id: "q", car_mode: "keep" }], ...over }) as never;

describe("ownCarMoveTargets", () => {
  it("offers my cars other than the ride's own", () => {
    expect(ownCarMoveTargets({ ride: ride(), myCarIds: ["mine", "shared"], dayPublished: true, now })).toEqual(["mine"]);
  });
  it("refuses unpublished, cancelled, past-day and relay rides", () => {
    const base = { myCarIds: ["mine"], dayPublished: true, now };
    expect(canMoveOntoMyCar({ ...base, ride: ride(), dayPublished: false })).toBe(false);
    expect(canMoveOntoMyCar({ ...base, ride: ride({ status: "cancelled" }) })).toBe(false);
    expect(canMoveOntoMyCar({ ...base, ride: ride({ starts_at: "2026-10-11T10:00:00Z" }) })).toBe(false);
    expect(canMoveOntoMyCar({ ...base, ride: ride({ served: [{ request_id: "q", car_mode: "relay" }] }) })).toBe(false);
    expect(canMoveOntoMyCar({ ...base, ride: ride() })).toBe(true);
  });
});
