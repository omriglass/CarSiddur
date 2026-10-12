import { describe, expect, it } from "vitest";

import { handOverCandidates } from "./handOver";

const person = (key: string, source: string, person_id: string | null) => ({ key, source, request_id: null, ride_passenger_id: null, person_id, child_id: null, display_name: key, seat_kind: "adult", added_by: null, removable: true });
const ride = (over: Record<string, unknown> = {}) => ({
  driver_id: "me", status: "confirmed", series_id: null,
  served: [{ request_id: "q1", role: "driver", car_mode: "keep" }],
  people: [person("a", "companion", "c1"), person("b", "added", "c2"), person("c", "added", "c3"), person("d", "guest", "c4"), person("e", "added", null)],
  ...over,
}) as never;
const members = [{ id: "c1", name: "A", doesNotDrive: false }, { id: "c2", name: "B", doesNotDrive: true }, { id: "c3", name: "C", doesNotDrive: false }, { id: "c4", name: "D", doesNotDrive: false }];
const mine = new Set(["q1"]);

describe("handOverCandidates", () => {
  it("lists driving companions and added passengers with a person id", () => {
    expect(handOverCandidates(ride(), "me", mine, members).map((c) => c.id)).toEqual(["c1", "c3"]);
  });
  it("is empty unless I drive a ride that serves only my requests and is no series", () => {
    expect(handOverCandidates(ride(), "other", mine, members)).toEqual([]);
    expect(handOverCandidates(ride({ series_id: "s" }), "me", mine, members)).toEqual([]);
    expect(handOverCandidates(ride({ served: [{ request_id: "q1" }, { request_id: "q2" }] }), "me", mine, members)).toEqual([]);
    expect(handOverCandidates(ride({ status: "cancelled" }), "me", mine, members)).toEqual([]);
  });
});
