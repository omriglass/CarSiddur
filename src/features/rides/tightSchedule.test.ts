import { describe, expect, it } from "vitest";

import { tightRideIdsOf } from "./tightSchedule";
import type { BoardRide } from "@/features/siddur/api";

const ride = (id: string, start: string, end: string, served: unknown[] = [{ request_id: `req-${id}` }]) => ({
  id, car_id: "car", starts_at: start, ends_at: end, origin_id: "home", destination_id: "home", series_id: null, served, auto_relocation: false,
}) as unknown as BoardRide;

describe("tightRideIdsOf", () => {
  it("marks two back-to-back rides meeting at home (the owner's 15:30-17:15 then 17:15-18:45)", () => {
    const rides = [ride("a", "2026-10-18T12:30:00Z", "2026-10-18T14:15:00Z", []), ride("b", "2026-10-18T14:15:00Z", "2026-10-18T15:45:00Z")];
    expect([...tightRideIdsOf(rides, 30, "home", [{ id: "car" }])].sort()).toEqual(["a", "b"]);
  });

  it("a handover away from the car's base is never tight", () => {
    const away = [ride("a", "2026-10-18T12:30:00Z", "2026-10-18T14:15:00Z"), ride("b", "2026-10-18T14:15:00Z", "2026-10-18T15:45:00Z")]
      .map((r) => ({ ...r, origin_id: "x", destination_id: "x" }));
    expect(tightRideIdsOf(away, 30, "home", [{ id: "car" }]).size).toBe(0);
  });
});
