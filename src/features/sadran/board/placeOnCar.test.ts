import { describe, expect, it } from "vitest";

import { carsFreeForRequest, placementMinutes } from "./placeOnCar";

import type { BoardDropContext } from "./dropValidity";
import type { UnmetListItem } from "./components/UnmetList";

const request = { id: "r1", requester_id: "m1", status: "waitlisted", trip_type: "round_trip", trip_shape: "round_trip", adults: 1, child_seats: 0, boosters: 0,
  depart_at: "2026-10-21T06:00:00.000Z", return_at: "2026-10-21T09:00:00.000Z", destination_id: "tlv" };
const item = { request, destinationName: "x" } as unknown as UnmetListItem;
const car = (id: string, name: string, status = "active") => ({ id, name, status });
const ctx = (over: Record<string, unknown> = {}) => ({
  rides: [], requests: [request], cars: [car("c2", "ב"), car("c1", "א"), car("c3", "ג", "retired")], maintenanceBlocks: [],
  seatConfigsByCarId: new Map(), seatConfigsLoaded: false, unmetItems: [item], selectedDay: "2026-10-21", chauffeurDwellMinutes: 30, ...over,
}) as unknown as BoardDropContext;

describe("placeOnCar (R14M1)", () => {
  it("the card's own start minute on the selected day (Asia/Jerusalem)", () => {
    expect(placementMinutes(ctx(), item)).toBe(9 * 60);
  });

  it("lists active free cars by name; a busy car and a retired car are left out", () => {
    const busy = { id: "ride", car_id: "c2", status: "confirmed", starts_at: "2026-10-21T07:00:00.000Z", ends_at: "2026-10-21T08:00:00.000Z" };
    expect(carsFreeForRequest(ctx(), item).map((c) => c.carId)).toEqual(["c1", "c2"]);
    expect(carsFreeForRequest(ctx({ rides: [busy] }), item).map((c) => c.carId)).toEqual(["c1"]);
  });

  it("nothing for a request on another day", () => {
    expect(carsFreeForRequest(ctx({ selectedDay: "2026-10-22" }), item)).toEqual([]);
  });
});
