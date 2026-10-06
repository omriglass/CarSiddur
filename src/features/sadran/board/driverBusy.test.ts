import { describe, expect, it } from "vitest";

import { busyDriverIds, sortFreeFirst } from "./driverBusy";

import type { BoardRide, WeekRequestRow } from "../api";

const ride = (over: Record<string, unknown>) => ({ id: "r", status: "confirmed", starts_at: "2026-10-12T08:00:00.000Z", ends_at: "2026-10-12T10:00:00.000Z", driver_id: null, people: [], ...over }) as unknown as BoardRide;

describe("busyDriverIds (R2U3)", () => {
  it("marks drivers/people of overlapping rides and ignores the ride itself and cancelled ones", () => {
    const target = ride({ id: "t" });
    const busy = busyDriverIds(target, [
      target,
      ride({ id: "a", driver_id: "p1", starts_at: "2026-10-12T09:00:00.000Z", ends_at: "2026-10-12T11:00:00.000Z" }),
      ride({ id: "b", driver_id: "p2", starts_at: "2026-10-12T10:00:00.000Z", ends_at: "2026-10-12T12:00:00.000Z" }),
      ride({ id: "c", driver_id: "p3", status: "cancelled" }),
    ], []);
    expect([...busy]).toEqual(["p1"]);
  });
  it("marks requesters with a live overlapping request", () => {
    const req = { status: "assigned", requester_id: "p4", trip_shape: "round_trip", depart_at: "2026-10-12T08:30:00.000Z", return_at: "2026-10-12T09:30:00.000Z" } as unknown as WeekRequestRow;
    const dead = { ...req, status: "withdrawn", requester_id: "p5" } as WeekRequestRow;
    expect([...busyDriverIds(ride({ id: "t" }), [], [req, dead])]).toEqual(["p4"]);
  });
  it("sorts free first", () => {
    expect(sortFreeFirst([{ id: "a" }, { id: "b" }, { id: "c" }], new Set(["a"])).map((c) => c.id)).toEqual(["b", "c", "a"]);
  });
});
