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
  it("names who rides and where to", () => {
    expect(carSwapRideLabel(ride())).toBe("יואב לחיפה");
  });

  it("prefers the first person on the ride over a missing driver", () => {
    expect(carSwapRideLabel(ride({ driver_name: null, person_name: "אגתה", label: "תל יצחק" }))).toBe("אגתה לתל יצחק");
  });

  it("falls back to the place when nobody is named", () => {
    expect(carSwapRideLabel(ride({ driver_name: null }))).toBe("חיפה");
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
      tv("carSwap.blockerSeats", { ride: "יואב לחיפה", car: "יונדאי 3" }),
    );
  });

  it("names the car and the ride for a maintenance blocker", () => {
    expect(carSwapBlockerMessage(blocker({ code: "maintenance" }), rides, carNames)).toBe(
      tv("carSwap.blockerMaintenance", { car: "יונדאי 3", ride: "יואב לחיפה" }),
    );
  });

  it("uses the fixed private-car message regardless of ride/car", () => {
    expect(carSwapBlockerMessage(blocker({ code: "private_car" }), rides, carNames)).toBe(he.carSwap.blockerPrivateCar);
  });

  it("names the ride for a past blocker", () => {
    expect(carSwapBlockerMessage(blocker({ code: "past" }), rides, carNames)).toBe(
      tv("carSwap.blockerPast", { ride: "יואב לחיפה" }),
    );
  });

  it("names the ride for a not_allowed blocker that has one", () => {
    expect(carSwapBlockerMessage(blocker({ code: "not_allowed" }), rides, carNames)).toBe(
      tv("carSwap.blockerNotAllowedRide", { ride: "יואב לחיפה" }),
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

describe("overlap blocker (REQ §13.180)", () => {
  it("names the moving ride, the car and the time of the ride staying there", () => {
    const message = carSwapBlockerMessage(
      { code: "overlap", ride_id: "ride-1", car_id: "car-b", starts_at: "2026-09-24T09:30:00Z", ends_at: "2026-09-24T10:30:00Z" },
      [ride()], { "car-b": "ואן" });
    expect(message).toContain("ואן");
    expect(message).toContain("12:30–13:30");
  });
});

describe("carSwapBlockerMessage — REQ §13.186 closed set", () => {
  it("names the size of a swap that is too large", () => {
    expect(carSwapBlockerMessage(blocker({ code: "swap_too_large", ride_id: null, rides: 61, days: 9 }), [], {})).toBe(
      tv("carSwap.blockerSwapTooLarge", { rides: "61", days: "9" }),
    );
  });
  it("names a pulled-in ride in an archived week", () => {
    expect(carSwapBlockerMessage(blocker({ code: "archived" }), [ride()], {})).toBe(tv("carSwap.blockerArchived", { ride: "יואב לחיפה" }));
  });
});
