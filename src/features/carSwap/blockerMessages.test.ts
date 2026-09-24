import { describe, expect, it } from "vitest";

import { he, tv } from "@/i18n/he";

import { carSwapBlockerMessage, carSwapRideLabel } from "./blockerMessages";

import type { CarSwapBlocker, CarSwapRide } from "./schema";

function ride(overrides: Partial<CarSwapRide> = {}): CarSwapRide {
  return {
    ride_id: "ride-1",
    car_id: "car-a",
    starts_at: "2026-09-24T06:00:00Z",
    ends_at: "2026-09-24T07:00:00Z",
    driver_name: "יואב",
    label: "חיפה",
    series_id: null,
    series_index: null,
    series_count: null,
    ...overrides,
  };
}

function blocker(overrides: Partial<CarSwapBlocker> = {}): CarSwapBlocker {
  return { code: "seats", ride_id: "ride-1", car_id: "car-b", detail: null, ...overrides };
}

describe("carSwapRideLabel", () => {
  it("prefers the ride's own label", () => {
    expect(carSwapRideLabel(ride())).toBe("חיפה");
  });

  it("falls back to the driver's name when there is no label", () => {
    expect(carSwapRideLabel(ride({ label: null }))).toBe("יואב");
  });

  it("falls back to a generic term when neither is present", () => {
    expect(carSwapRideLabel(ride({ label: null, driver_name: null }))).toBe(he.carSwap.unknownRide);
  });

  it("falls back to the generic term for a blocker with no matching ride", () => {
    expect(carSwapRideLabel(undefined)).toBe(he.carSwap.unknownRide);
  });
});

describe("carSwapBlockerMessage", () => {
  const rides = [ride()];
  const carNames = { "car-a": "יונדאי 1", "car-b": "יונדאי 3" };

  it("names the ride and the target car for a seats/luggage blocker", () => {
    expect(carSwapBlockerMessage(blocker({ code: "seats" }), rides, carNames)).toBe(
      tv("carSwap.blockerSeats", { ride: "חיפה", car: "יונדאי 3" }),
    );
  });

  it("names the car and the ride for a maintenance blocker", () => {
    expect(carSwapBlockerMessage(blocker({ code: "maintenance" }), rides, carNames)).toBe(
      tv("carSwap.blockerMaintenance", { car: "יונדאי 3", ride: "חיפה" }),
    );
  });

  it("uses the fixed private-car message regardless of ride/car", () => {
    expect(carSwapBlockerMessage(blocker({ code: "private_car" }), rides, carNames)).toBe(he.carSwap.blockerPrivateCar);
  });

  it("names the ride for a past blocker", () => {
    expect(carSwapBlockerMessage(blocker({ code: "past" }), rides, carNames)).toBe(
      tv("carSwap.blockerPast", { ride: "חיפה" }),
    );
  });

  it("names the ride for a not_allowed blocker that has one", () => {
    expect(carSwapBlockerMessage(blocker({ code: "not_allowed" }), rides, carNames)).toBe(
      tv("carSwap.blockerNotAllowedRide", { ride: "חיפה" }),
    );
  });

  it("falls back to the day-level generic message when not_allowed names no ride", () => {
    expect(carSwapBlockerMessage(blocker({ code: "not_allowed", ride_id: null }), rides, carNames)).toBe(
      he.carSwap.blockerNotAllowedGeneric,
    );
  });

  it("never renders the raw `detail` field (Hebrew lives only in i18n/reasons/seed data)", () => {
    const message = carSwapBlockerMessage(blocker({ detail: "SOME_MACHINE_CODE" }), rides, carNames);
    expect(message).not.toContain("SOME_MACHINE_CODE");
  });
});
