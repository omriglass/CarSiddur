import { describe, expect, it } from "vitest";

import type { BoardRide } from "@/features/rides/api";

import { carsToShow, computeCelebrationStats, peoplePerCar } from "./celebrationStats";

function ride(id: string, over: Record<string, unknown>): BoardRide {
  return { id, status: "confirmed", starts_at: "2026-10-12T08:00:00Z", auto_relocation: false, served: [], people: [], ...over } as unknown as BoardRide;
}
const person = (id: string) => ({ key: id, source: "requester", request_id: null, ride_passenger_id: null, person_id: id, child_id: null, display_name: id, seat_kind: "adult", added_by: null, removable: true });
const served = (rid: string) => ({ request_id: rid, role: "driver", leg: "both", car_mode: "keep", adults: 1, child_seats: 0, boosters: 0, luggage: false });

describe("computeCelebrationStats", () => {
  it("counts rides, distinct people and shared rides; skips cancelled, reservations and other days", () => {
    const rides = [
      ride("a", { served: [served("r1")], people: [person("p1"), person("p2")] }),
      ride("b", { served: [served("r2"), served("r3")], people: [person("p2"), person("p3")] }),
      ride("c", { status: "cancelled", served: [served("r4")], people: [person("p9")] }),
      ride("d", { served: [] }),
      ride("e", { starts_at: "2026-10-13T08:00:00Z", served: [served("r5")], people: [person("p8")] }),
    ];
    expect(computeCelebrationStats(rides, ["2026-10-12"])).toEqual({ rides: 2, people: 3, shared: 1 });
    expect(computeCelebrationStats(rides).rides).toBe(3);
  });
});

describe("carsToShow", () => {
  it("is one per ride up to 15, then scaled and capped at 30", () => {
    expect(carsToShow(0)).toBe(0);
    expect(carsToShow(7)).toBe(7);
    expect(carsToShow(15)).toBe(15);
    expect(carsToShow(16)).toBe(16);
    expect(carsToShow(25)).toBe(20);
    expect(carsToShow(45)).toBe(30);
    expect(carsToShow(500)).toBe(30);
  });
});

describe("peoplePerCar", () => {
  it("rounds the real average into 1..4", () => {
    expect(peoplePerCar({ rides: 0, people: 0 })).toBe(0);
    expect(peoplePerCar({ rides: 10, people: 4 })).toBe(1);
    expect(peoplePerCar({ rides: 10, people: 25 })).toBe(3);
    expect(peoplePerCar({ rides: 2, people: 20 })).toBe(4);
  });
});
