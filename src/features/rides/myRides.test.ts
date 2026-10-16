import { describe, expect, it } from "vitest";

import { isMyDraftRide, isRideOfMine, relatedRideLabels, selectRelatedRides } from "./myRides";

import type { BoardRide } from "./api";

function person(source: string, over: Record<string, unknown> = {}) {
  return { key: `${source}:${String(over.person_id ?? over.child_id ?? "x")}`, source, request_id: null, ride_passenger_id: null, person_id: null, child_id: null, display_name: "x", seat_kind: "adult", added_by: null, removable: true, ...over };
}
function ride(over: Record<string, unknown> = {}): BoardRide {
  return { id: "r1", status: "confirmed", driver_id: "d", served: [], passengers: [], people: [], ...over } as unknown as BoardRide;
}

describe("isRideOfMine", () => {
  const none = new Set<string>();
  it("accepts driver, my served request, named passenger and any people row of mine (companion)", () => {
    expect(isRideOfMine(ride({ driver_id: "me" }), "me", none)).toBe(true);
    expect(isRideOfMine(ride({ served: [{ request_id: "q1", role: "passenger" }] }), "me", new Set(["q1"]))).toBe(true);
    expect(isRideOfMine(ride({ passengers: [{ person_id: "me" }] }), "me", none)).toBe(true);
    expect(isRideOfMine(ride({ people: [person("companion", { person_id: "me" })] }), "me", none)).toBe(true);
    expect(isRideOfMine(ride({ people: [person("added", { person_id: "me" })] }), "me", none)).toBe(true);
  });
  it("refuses a stranger and a signed-out viewer", () => {
    expect(isRideOfMine(ride({ people: [person("companion", { person_id: "other" })] }), "me", none)).toBe(false);
    expect(isRideOfMine(ride({ driver_id: "me" }), undefined, none)).toBe(false);
  });
  it("a draft (unpublished) ride is mine only as driver or named — never through a request or a people row", () => {
    expect(isRideOfMine(ride({ status: "draft", driver_id: "me" }), "me", none)).toBe(true);
    expect(isMyDraftRide(ride({ status: "draft", passengers: [{ person_id: "me" }] }), "me")).toBe(true);
    expect(isRideOfMine(ride({ status: "draft", served: [{ request_id: "q1", role: "passenger" }] }), "me", new Set(["q1"]))).toBe(false);
    expect(isRideOfMine(ride({ status: "draft", people: [person("companion", { person_id: "me" })] }), "me", none)).toBe(false);
  });
});

describe("related (children / co-guardians) rides", () => {
  const scope = { profileId: "me", childIds: new Set(["kid"]), guardianIds: new Set(["spouse"]) };
  it("labels a ride with my child on it", () => {
    const r = ride({ people: [person("driver", { person_id: "d" }), person("child", { child_id: "kid", display_name: "Noa" })] });
    expect(relatedRideLabels(r, scope)).toEqual([{ kind: "child", name: "Noa" }]);
  });
  it("labels a ride another guardian of my child is on, once", () => {
    const r = ride({ people: [person("driver", { person_id: "spouse", display_name: "Dana" }), person("requester", { person_id: "spouse", display_name: "Dana", key: "r" })] });
    expect(relatedRideLabels(r, scope)).toEqual([{ kind: "guardian", name: "Dana" }]);
  });
  it("ignores cancelled and draft rides and unrelated people", () => {
    const people = [person("child", { child_id: "kid" })];
    expect(relatedRideLabels(ride({ status: "cancelled", people }), scope)).toEqual([]);
    expect(relatedRideLabels(ride({ status: "draft", people }), scope)).toEqual([]);
    expect(relatedRideLabels(ride({ people: [person("child", { child_id: "other" })] }), scope)).toEqual([]);
  });
  it("selectRelatedRides skips rides that are already mine", () => {
    const mine = ride({ id: "a", driver_id: "me", people: [person("child", { child_id: "kid" })] });
    const theirs = ride({ id: "b", people: [person("child", { child_id: "kid" })] });
    expect([...selectRelatedRides([mine, theirs], scope, new Set()).keys()]).toEqual(["b"]);
  });
});
