import { describe, expect, it } from "vitest";

import { waitingLanes, waitingPeople, waitingRequestIdOf } from "./siddurLanes";
import type { WaitingRequest } from "./types";

function waiting(id: string, day: string, from: string, until: string, extra: Partial<WaitingRequest> = {}): WaitingRequest {
  return {
    request_id: id, requester_id: `p-${id}`, requester_name: `name-${id}`, companion_names: [], child_names: [], guest_names: [],
    adults: 1, child_seats: 0, boosters: 0, trip_type: "round_trip",
    depart_at: `${day}T${from}:00.000Z`, return_at: `${day}T${until}:00.000Z`,
    starts_at: `${day}T${from}:00.000Z`, ends_at: `${day}T${until}:00.000Z`, day,
    origin_name: "home", origin_is_home: true, destination_name: "dest", is_mine: false, version: 1, ...extra,
  };
}

const minutesOf = (iso: string) => new Date(iso).getUTCHours() * 60 + new Date(iso).getUTCMinutes();
const lanes = (requests: WaitingRequest[], day = "2026-11-04") =>
  waitingLanes(requests, day, minutesOf, (i) => `lane${i + 1}`, (r) => r.requester_name);

describe("waitingLanes", () => {
  it("puts overlapping requests in separate lanes and reuses a lane once a request ends", () => {
    const { cars, rides } = lanes([
      waiting("a", "2026-11-04", "08:00", "12:00"),
      waiting("b", "2026-11-04", "10:00", "14:00"),
      waiting("c", "2026-11-04", "13:00", "15:30"),
    ]);
    expect(cars.map((car) => car.id)).toEqual(["phantom:waiting:0", "phantom:waiting:1"]);
    expect(cars.every((car) => car.group === "phantom")).toBe(true);
    expect(rides.map((ride) => [ride.id, ride.carId, ride.startMinutes, ride.endMinutes])).toEqual([
      ["waiting:a", "phantom:waiting:0", 480, 720],
      ["waiting:b", "phantom:waiting:1", 600, 840],
      ["waiting:c", "phantom:waiting:0", 780, 930],
    ]);
    expect(rides.every((ride) => ride.kind === "waiting")).toBe(true);
  });

  it("shows only the selected day and no column on a day with nobody waiting", () => {
    expect(lanes([waiting("a", "2026-11-05", "08:00", "12:00")])).toEqual({ cars: [], rides: [] });
  });

  it("marks my own waiting request", () => {
    expect(lanes([waiting("a", "2026-11-04", "08:00", "09:00", { is_mine: true })]).rides[0]?.isMine).toBe(true);
  });
});

describe("waitingPeople / waitingRequestIdOf", () => {
  it("lists the requester first, then companions, children and guests", () => {
    expect(waitingPeople({ requester_name: "A", companion_names: ["B"], child_names: ["C"], guest_names: ["D"] })).toEqual(["A", "B", "C", "D"]);
  });
  it("reads the request id back from a grid block id", () => {
    expect(waitingRequestIdOf("waiting:r1")).toBe("r1");
    expect(waitingRequestIdOf("ride-1")).toBeNull();
  });
});
