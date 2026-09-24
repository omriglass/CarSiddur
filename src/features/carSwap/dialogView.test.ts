import { describe, expect, it } from "vitest";

import { carSwapConfirmDisabled, carSwapSeriesRangeLabel, groupCarSwapRidesByCar } from "./dialogView";

import type { CarSwapPreview, CarSwapRide, CarSwapSeries } from "./schema";

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

describe("groupCarSwapRidesByCar", () => {
  it("splits the flat rides array into the two cars' own groups, in carA/carB order", () => {
    const rides = [ride({ ride_id: "r1", car_id: "car-a" }), ride({ ride_id: "r2", car_id: "car-b" }), ride({ ride_id: "r3", car_id: "car-a" })];
    const groups = groupCarSwapRidesByCar(rides, { id: "car-a", name: "Car A" }, { id: "car-b", name: "Car B" });
    expect(groups).toHaveLength(2);
    const [groupA, groupB] = groups;
    expect(groupA).toMatchObject({ carId: "car-a", carName: "Car A" });
    expect(groupA!.rides.map((r) => r.ride_id)).toEqual(["r1", "r3"]);
    expect(groupB!.rides.map((r) => r.ride_id)).toEqual(["r2"]);
  });

  it("returns an empty rides array for a car with nothing to move (A2: one-way swap)", () => {
    const rides = [ride({ ride_id: "r1", car_id: "car-a" })];
    const groups = groupCarSwapRidesByCar(rides, { id: "car-a", name: "Car A" }, { id: "car-b", name: "Car B" });
    expect(groups[1]!.rides).toEqual([]);
  });
});

describe("carSwapSeriesRangeLabel", () => {
  function series(overrides: Partial<CarSwapSeries> = {}): CarSwapSeries {
    return { series_id: "s1", car_id: "car-a", days: ["2026-09-14", "2026-09-17"], first_day: "2026-09-14", last_day: "2026-09-17", ...overrides };
  }

  it("renders one series' first/last day with their weekday letters", () => {
    expect(carSwapSeriesRangeLabel([series()])).toBe("ב׳ 14.9 – ה׳ 17.9");
  });

  it("joins several series' ranges", () => {
    expect(carSwapSeriesRangeLabel([series(), series({ series_id: "s2", first_day: "2026-09-15", last_day: "2026-09-16" })])).toBe(
      "ב׳ 14.9 – ה׳ 17.9; ג׳ 15.9 – ד׳ 16.9",
    );
  });

  it("returns an empty string for no series", () => {
    expect(carSwapSeriesRangeLabel([])).toBe("");
  });
});

describe("carSwapConfirmDisabled", () => {
  function preview(overrides: Partial<CarSwapPreview> = {}): CarSwapPreview {
    return { fingerprint: "f1", rides: [], series: [], blockers: [], notices: [], can_swap: true, notify: true, ...overrides };
  }

  it("is disabled while there is no preview yet", () => {
    expect(carSwapConfirmDisabled(undefined)).toBe(true);
  });

  it("is disabled when the preview itself says the swap can't go through", () => {
    expect(carSwapConfirmDisabled(preview({ can_swap: false }))).toBe(true);
  });

  it("is enabled once a preview allows the swap", () => {
    expect(carSwapConfirmDisabled(preview({ can_swap: true }))).toBe(false);
  });
});
