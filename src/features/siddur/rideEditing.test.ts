import { describe, expect, it } from "vitest";
import type { BoardRide } from "./api";
import { conflictingRides, moveOnRideDay } from "./rideEditing";

const ride = { id: "mine", version: 2, car_id: "car", starts_at: "2026-09-10T07:00:00Z", ends_at: "2026-09-10T09:00:00Z" } as BoardRide;
describe("member ride changes", () => {
  it("resizes either edge on the original Jerusalem day", () => {
    expect(moveOnRideDay(ride, "car2", 9 * 60, 12 * 60)).toMatchObject({ startsAt: "2026-09-10T06:00:00.000Z", endsAt: "2026-09-10T09:00:00.000Z", carId: "car2" });
    expect(moveOnRideDay(ride, "car", 10 * 60, 13 * 60)?.endsAt).toBe("2026-09-10T10:00:00.000Z");
  });
  it("allows 23:59 and rejects midnight, day overflow and reversed windows", () => {
    expect(moveOnRideDay(ride, "car", 23 * 60, 1439)?.endsAt).toBe("2026-09-10T20:59:00.000Z");
    expect(moveOnRideDay(ride, "car", 23 * 60, 1440)).toBeNull();
    expect(moveOnRideDay(ride, "car", 23 * 60, 1455)).toBeNull();
    expect(moveOnRideDay(ride, "car", 600, 500)).toBeNull();
  });
  it("detects all conflicting rides including turnaround, without treating own ride as a conflict", () => {
    const move = moveOnRideDay(ride, "car", 600, 720)!;
    const next = { ...ride, id: "other", starts_at: "2026-09-10T09:15:00Z", ends_at: "2026-09-10T10:15:00Z" };
    expect(conflictingRides(move, [ride, next], 30).map((r) => r.id)).toEqual(["other"]);
    expect(conflictingRides(move, [ride, next], 15)).toEqual([]);
  });
});
