import { describe, expect, it } from "vitest";

import { isMergedRide, isRideRelated, relatedRequestIdToEdit, rideMovableByMember } from "./relatedRide";
import { servedOf } from "./servedOf";

import type { BoardRide } from "./api";

function ride(over: Record<string, unknown> = {}): BoardRide {
  return { id: "r1", driver_id: "d", served: [], people: [], ...over } as unknown as BoardRide;
}
const served = (entries: { request_id: string; role: "driver" | "passenger" }[]) => entries.map((e) => ({ ...e, leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: false }));

describe("isRideRelated", () => {
  it("accepts driver, a served request of mine, and the private car's owner", () => {
    expect(isRideRelated({ ride: ride({ driver_id: "me" }), profileId: "me", myRequestIds: new Set() })).toBe(true);
    expect(isRideRelated({ ride: ride({ served: served([{ request_id: "q1", role: "passenger" }]) }), profileId: "me", myRequestIds: new Set(["q1"]) })).toBe(true);
    expect(isRideRelated({ ride: ride(), profileId: "me", myRequestIds: new Set(), carOwnerId: "me" })).toBe(true);
  });
  it("refuses a stranger and a signed-out caller", () => {
    expect(isRideRelated({ ride: ride(), profileId: "me", myRequestIds: new Set(), carOwnerId: "other" })).toBe(false);
    expect(isRideRelated({ ride: ride({ driver_id: "me" }), profileId: undefined, myRequestIds: new Set() })).toBe(false);
  });
});

describe("relatedRequestIdToEdit", () => {
  it("prefers the driver's request, else the first served one", () => {
    const r = ride({ served: served([{ request_id: "p", role: "passenger" }, { request_id: "d", role: "driver" }]) });
    expect(relatedRequestIdToEdit(r)).toBe("d");
    expect(relatedRequestIdToEdit(ride({ served: served([{ request_id: "p", role: "passenger" }]) }))).toBe("p");
    expect(relatedRequestIdToEdit(ride())).toBeUndefined();
  });
});

describe("merged rides (REQ §13.179)", () => {
  const host = { request_id: "qh", role: "driver", leg: "both", car_mode: "keep" };
  const guest = { request_id: "qg", role: "passenger", leg: "out", car_mode: "passenger" };
  it("a guest riding along never stops a member moving the ride; a chauffeur leg or a הקפצה relay does", () => {
    expect(rideMovableByMember(ride({ served: [host, guest] }))).toBe(true);
    expect(rideMovableByMember(ride({ served: [{ ...guest, car_mode: "chauffeur" }] }))).toBe(false);
    expect(rideMovableByMember(ride({ served: [{ ...host, car_mode: "relay", trip_type: "drop_off" }] }))).toBe(false);
    expect(rideMovableByMember(ride({ served: [{ ...host, car_mode: "relay", trip_type: "one_way" }] }))).toBe(true);
  });
  it("is merged when it serves more than one request", () => {
    expect(isMergedRide(ride({ served: [host, guest] }))).toBe(true);
    expect(isMergedRide(ride({ served: [host] }))).toBe(false);
  });
  it("reads each request's leg on this ride from people (a reversed pickup rides the way back)", () => {
    const entries = servedOf(ride({ served: [host, guest], people: [{ request_id: "qg", leg: "return" }, { request_id: "qh", leg: "both" }] }));
    expect(entries.map((entry) => [entry.request_id, entry.leg, entry.ride_leg])).toEqual([["qh", "both", "both"], ["qg", "out", "return"]]);
  });
});
