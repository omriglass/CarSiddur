import { describe, expect, it } from "vitest";

import type { SubmitRequestResult } from "./api";
import { attachToBlocker, carTakenChoice } from "./submitOutcome";

const result = (partial: Partial<SubmitRequestResult>) => partial as SubmitRequestResult;

// PR3 (owner 2026-11-15): an edit whose booked car is taken at the new hours asks — another car, make room, or attach.
describe("carTakenChoice", () => {
  const blocker = { ride_id: "r", car_id: "c", car_name: "Car", name: "Dana", starts_at: "2026-11-15T06:00:00Z", ends_at: "2026-11-15T09:00:00Z", mine: false };
  it("reads the server's question, and nothing else", () => {
    expect(carTakenChoice(result({ needs_confirmation: "car_taken_choice", car_blocker: blocker, other_car: { id: "o", name: "Other" }, my_ride: { id: "m", version: 3, car_id: "c" } })))
      .toEqual({ blocker, otherCar: { id: "o", name: "Other" }, myRide: { id: "m", version: 3, car_id: "c" } });
    expect(carTakenChoice(result({ needs_confirmation: "car_taken_choice", car_blocker: blocker }))).toEqual({ blocker, otherCar: null, myRide: null });
    expect(carTakenChoice(result({ needs_confirmation: "car_stays_away" }))).toBeNull();
    expect(carTakenChoice(null)).toBeNull();
  });
});

describe("attachToBlocker", () => {
  const blocker = { starts_at: "2026-11-15T06:00:00Z", ends_at: "2026-11-15T09:00:00Z" };
  it("leaves when the ride in the way ends, when that ride began first", () => {
    expect(attachToBlocker("2026-11-15T08:30:00Z", "2026-11-15T10:30:00Z", blocker)).toEqual({ departAt: "2026-11-15T09:00:00Z" });
    // a one-way leg has only a departure
    expect(attachToBlocker("2026-11-15T08:30:00Z", null, blocker)).toEqual({ departAt: "2026-11-15T09:00:00Z" });
  });
  it("is back when the ride in the way starts, when my trip began first", () => {
    expect(attachToBlocker("2026-11-15T04:00:00Z", "2026-11-15T07:00:00Z", blocker)).toEqual({ returnAt: "2026-11-15T06:00:00Z" });
  });
  it("offers nothing when no part of the trip would be left", () => {
    expect(attachToBlocker("2026-11-15T07:00:00Z", "2026-11-15T08:00:00Z", blocker)).toBeNull();
    expect(attachToBlocker("2026-11-15T07:00:00Z", "2026-11-15T09:00:00Z", blocker)).toBeNull();
  });
});
