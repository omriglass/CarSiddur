import { describe, expect, it } from "vitest";

import type { BoardRide } from "./api";
import { chainNeighbours, chainPairKey, chainTripOf } from "./chainSuggest";

const person = (id: string, requestId: string, source = "requester") => ({
  key: `${source}:${id}`, source, request_id: requestId, ride_passenger_id: null, person_id: id, child_id: null,
  display_name: id, seat_kind: "adult", added_by: null, removable: true,
});

const at = (time: string) => `2041-03-04T${time}:00+02:00`;

function ride(id: string, requestId: string, from: string, to: string, people: string[], overrides: Partial<Record<string, unknown>> = {}): BoardRide {
  return {
    id, status: "draft", car_id: `car-${id}`, driver_id: people[0], needs_driver: false, starts_at: at(from), ends_at: at(to), origin_id: "home",
    served: [{ request_id: requestId, role: "driver", leg: "both", car_mode: "keep", trip_type: "round_trip", origin_id: "home", adults: people.length, child_seats: 0, boosters: 0, luggage: false }],
    people: people.map((p, i) => person(p, requestId, i === 0 ? "driver" : "companion")),
    ...overrides,
  } as unknown as BoardRide;
}

describe("chainNeighbours (CM1 phase 4, REQ item 260 d)", () => {
  const school = ride("a", "qa", "07:45", "08:15", ["m1"]);
  const day = ride("b", "qb", "08:30", "14:00", ["m1", "m2"]);

  it("finds the same person's ride next to it, either side", () => {
    expect(chainNeighbours(chainTripOf(school)!, [school, day], 30).map((t) => t.rideId)).toEqual(["b"]);
    expect(chainNeighbours(chainTripOf(day)!, [school, day], 30).map((t) => t.rideId)).toEqual(["a"]);
  });

  it("ignores another person's ride, a far ride, another day, another start place and a declined pair", () => {
    const other = ride("c", "qc", "08:30", "12:00", ["m3"]);
    const far = ride("d", "qd", "11:00", "12:00", ["m1"]);
    const tomorrow = ride("e", "qe", "08:30", "12:00", ["m1"], { starts_at: "2041-03-05T08:30:00+02:00", ends_at: "2041-03-05T12:00:00+02:00" });
    const elsewhere = ride("f", "qf", "08:30", "12:00", ["m1"]);
    (elsewhere.served as unknown as { origin_id: string }[])[0]!.origin_id = "haifa";
    const trip = chainTripOf(school)!;
    expect(chainNeighbours(trip, [school, other, far, tomorrow, elsewhere], 30)).toEqual([]);
    expect(chainNeighbours(trip, [school, day], 30, new Set([chainPairKey("qb", "qa")]))).toEqual([]);
  });

  it("a ride with someone else's trip too: offered when the other side is alone, not when both carry others (R22U1)", () => {
    const guest = { request_id: "qx", role: "passenger", leg: "both", car_mode: "passenger", trip_type: "round_trip", origin_id: "home", adults: 1, child_seats: 0, boosters: 0, luggage: false };
    const busyDay = ride("b", "qb", "08:30", "14:00", ["m1", "m2"]);
    (busyDay.served as unknown as object[]).push(guest);
    const busySchool = ride("a", "qa", "07:45", "08:15", ["m1"]);
    (busySchool.served as unknown as object[]).push({ ...guest, request_id: "qy" });
    expect(chainTripOf(busyDay)).toMatchObject({ requestId: "qb", alone: false });
    expect(chainNeighbours(chainTripOf(school)!, [school, busyDay], 30).map((t) => t.rideId)).toEqual(["b"]);
    expect(chainNeighbours(chainTripOf(busySchool)!, [busySchool, busyDay], 30)).toEqual([]);
  });

  it("only round-trip trips chain", () => {
    expect(chainTripOf(ride("g", "qg", "08:30", "12:00", ["m1"], { served: [] }))).toBeNull();
    const oneWay = ride("h", "qh", "08:30", "12:00", ["m1"]);
    (oneWay.served as unknown as { leg: string }[])[0]!.leg = "out";
    expect(chainTripOf(oneWay)).toBeNull();
  });
});
