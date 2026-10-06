import { describe, expect, it } from "vitest";

import { joinableDropOffLegs } from "./joinLegs";

import type { BoardRide } from "../api";

const ride = (id: string, leg: "out" | "return" | "both", startsAt: string, endsAt: string, extra: Record<string, unknown> = {}, requestId = "q1", carMode = "chauffeur"): BoardRide =>
  ({ id, status: "flagged", starts_at: startsAt, ends_at: endsAt, served: [{ request_id: requestId, role: "passenger", leg, car_mode: carMode, adults: 1, child_seats: 0, boosters: 0, luggage: false }], ...extra }) as unknown as BoardRide;

describe("joinableDropOffLegs (REQ §13.105 c)", () => {
  const out = ride("a", "out", "2026-10-15T04:15:00Z", "2026-10-15T05:00:00Z");
  const pickup = ride("b", "return", "2026-10-15T11:00:00Z", "2026-10-15T11:45:00Z");
  it("finds the other leg from either ride", () => {
    expect(joinableDropOffLegs(out, [out, pickup])).toEqual({ requestId: "q1", otherRideId: "b" });
    expect(joinableDropOffLegs(pickup, [out, pickup])).toEqual({ requestId: "q1", otherRideId: "a" });
  });
  it("needs both legs, as chauffeur rides, of the same single request", () => {
    expect(joinableDropOffLegs(out, [out])).toBeNull();
    expect(joinableDropOffLegs(out, [out, ride("c", "return", pickup.starts_at!, pickup.ends_at!, {}, "q2")])).toBeNull();
    expect(joinableDropOffLegs(out, [out, ride("d", "return", pickup.starts_at!, pickup.ends_at!, {}, "q1", "keep")])).toBeNull();
  });
  it("refuses a pickup that starts before the drop-off ends, and a cancelled ride", () => {
    expect(joinableDropOffLegs(out, [out, ride("e", "return", "2026-10-15T04:30:00Z", "2026-10-15T05:30:00Z")])).toBeNull();
    expect(joinableDropOffLegs(out, [out, { ...pickup, status: "cancelled" } as BoardRide])).toBeNull();
  });
  it("a shared ride is not joinable", () => {
    const shared = { ...out, served: [...(out.served as unknown[]), (pickup.served as unknown[])[0]] } as unknown as BoardRide;
    expect(joinableDropOffLegs(shared, [shared, pickup])).toBeNull();
  });
});
