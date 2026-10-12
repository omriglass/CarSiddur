import { describe, expect, it } from "vitest";

import { isRideRelated, relatedRequestIdToEdit } from "./relatedRide";

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
