import { describe, expect, it } from "vitest";

import { busyDriverIds, driverOverlapRideIds, personDayEntries, sortFreeFirst } from "./driverBusy";

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

describe("driverOverlapRideIds (owner 2026-10-16)", () => {
  it("marks both rides of one driver with overlapping windows, drafts included, not touching or cancelled ones", () => {
    const ids = driverOverlapRideIds([
      ride({ id: "a", driver_id: "p1" }),
      ride({ id: "b", driver_id: "p1", status: "draft", starts_at: "2026-10-12T09:00:00.000Z", ends_at: "2026-10-12T11:00:00.000Z" }),
      ride({ id: "c", driver_id: "p1", starts_at: "2026-10-12T11:00:00.000Z", ends_at: "2026-10-12T12:00:00.000Z" }),
      ride({ id: "d", driver_id: "p1", status: "cancelled" }),
      ride({ id: "e", driver_id: "p2" }),
      ride({ id: "f", driver_id: null }),
      ride({ id: "g", driver_id: null }),
    ]);
    expect([...ids].sort()).toEqual(["a", "b"]);
  });
});

describe("personDayEntries (R13F2)", () => {
  const req = (over: Record<string, unknown>) => ({ id: "q", status: "assigned", requester_id: "p1", trip_shape: "round_trip",
    depart_at: "2026-10-12T12:00:00.000Z", return_at: "2026-10-12T13:00:00.000Z", destination_resolved_name: "חדרה", ...over }) as unknown as WeekRequestRow;
  it("lists the person's rides (driving or riding) and unplaced requests that day, by time, marking overlaps", () => {
    const target = ride({ id: "t" });
    const entries = personDayEntries("p1", target, [
      target,
      ride({ id: "a", driver_id: "p1", starts_at: "2026-10-12T09:00:00.000Z", ends_at: "2026-10-12T11:00:00.000Z", served: [{ request_id: "q1" }] }),
      ride({ id: "b", driver_id: "p9", starts_at: "2026-10-12T14:00:00.000Z", ends_at: "2026-10-12T15:00:00.000Z",
        people: [{ key: "x", source: "added", request_id: null, ride_passenger_id: "rp", person_id: "p1", child_id: null, display_name: "P1", seat_kind: "adult", added_by: null, removable: true }], served: [{ request_id: "q2" }] }),
      ride({ id: "c", driver_id: "p1", status: "cancelled" }),
      ride({ id: "d", driver_id: "p1", starts_at: "2026-10-13T09:00:00.000Z", ends_at: "2026-10-13T10:00:00.000Z" }),
    ], [req({ id: "q1" }), req({ id: "q2", requester_id: "p9", destination_resolved_name: "עפולה" }),
        req({ id: "q3", status: "waitlisted", depart_at: "2026-10-12T16:00:00.000Z", return_at: "2026-10-12T17:00:00.000Z", destination_resolved_name: "קיסריה" }),
        req({ id: "q4", status: "withdrawn" })]);
    expect(entries.map((e) => [e.kind, e.startsAt, e.destination, e.overlaps])).toEqual([
      ["drives", "2026-10-12T09:00:00.000Z", "חדרה", true],
      ["rides", "2026-10-12T14:00:00.000Z", "עפולה", false],
      ["request", "2026-10-12T16:00:00.000Z", "קיסריה", false],
    ]);
  });
});
