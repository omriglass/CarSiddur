import { describe, expect, it } from "vitest";

import type { BoardRide } from "@/features/rides/api";

import { duplicateEffects } from "./duplicateEffects";

function ride(id: string, startsAt: string, served: { request_id: string; role: "driver" | "passenger" }[], extra: Partial<BoardRide> = {}): BoardRide {
  return { id, starts_at: startsAt, status: "draft", driver_name: null, people: [],
    served: served.map((s) => ({ ...s, leg: "both", car_mode: "keep", adults: 1 })), ...extra } as unknown as BoardRide;
}

describe("duplicateEffects (production 2026-11-12)", () => {
  it("names the ride the request joined as a guest and its own ride", () => {
    const rides = [
      ride("pickup", "2026-11-15T09:30:00Z", [{ request_id: "noni", role: "passenger" }]),
      ride("host", "2026-11-15T05:15:00Z", [{ request_id: "noga", role: "driver" }, { request_id: "noni", role: "passenger" }], { driver_name: "Noga" }),
      ride("other", "2026-11-15T06:00:00Z", [{ request_id: "x", role: "driver" }]),
    ];
    expect(duplicateEffects(rides, "noni")).toEqual([
      { rideId: "host", startsAt: "2026-11-15T05:15:00Z", kind: "guest", driverName: "Noga" },
      { rideId: "pickup", startsAt: "2026-11-15T09:30:00Z", kind: "own", driverName: null },
    ]);
  });

  it("is empty for an unplaced request and skips cancelled rides", () => {
    expect(duplicateEffects([ride("a", "2026-11-15T06:00:00Z", [{ request_id: "x", role: "driver" }])], "noni")).toEqual([]);
    expect(duplicateEffects([ride("a", "2026-11-15T06:00:00Z", [{ request_id: "noni", role: "driver" }], { status: "cancelled" })], "noni")).toEqual([]);
  });
});
