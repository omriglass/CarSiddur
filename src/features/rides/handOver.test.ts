import { describe, expect, it } from "vitest";

import { handOverCandidates, mergedLeaveOptions } from "./handOver";

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

describe("mergedLeaveOptions (REQ item 229)", () => {
  const p = (key: string, source: string, person_id: string | null, request_id: string | null, leg: string | null = "both") =>
    ({ ...person(key, source, person_id), request_id, leg });
  const merged = (people: unknown[]) => ({ driver_id: "me", status: "confirmed", series_id: null, served: [], people }) as never;
  const all = [...members, { id: "g1", name: "G", doesNotDrive: false }, { id: "g2", name: "H", doesNotDrive: false }, { id: "me", name: "Me", doesNotDrive: false }];

  it("offers the other members on the merge who drive both ways, and no driver", () => {
    const options = mergedLeaveOptions(merged([
      p("d", "driver", "me", "q1"), p("g", "requester", "g1", "q2"), p("h", "requester", "g2", "q3", "out"), p("x", "added", "c3", null),
    ]), "me", all);
    expect(options?.candidates.map((c) => c.id)).toEqual(["g1", "c3"]);
    expect(options?.noDriver).toBe(true);
  });

  it("is null for a ride that is not a merge, or that someone else drives", () => {
    expect(mergedLeaveOptions(merged([p("d", "driver", "me", "q1"), p("a", "companion", "c1", "q1")]), "me", all)).toBeNull();
    expect(mergedLeaveOptions(merged([p("d", "driver", "me", "q1"), p("g", "requester", "g1", "q2")]), "other", all)).toBeNull();
  });

  it("when my request carries others, only its companions may take it over, and there is no 'no driver'", () => {
    const options = mergedLeaveOptions(merged([
      p("d", "driver", "me", "q1"), p("a", "companion", "c1", "q1"), p("g", "requester", "g1", "q2"),
    ]), "me", all);
    expect(options?.candidates.map((c) => c.id)).toEqual(["c1"]);
    expect(options?.noDriver).toBe(false);
  });
});
