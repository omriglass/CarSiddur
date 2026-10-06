import { describe, expect, it } from "vitest";

import { carAwayPlaceAtDayStart, hideIdleTemporaryCars } from "./weekGridCars";

describe("hideIdleTemporaryCars", () => {
  const cars = [
    { id: "shared-1", group: "shared" },
    { id: "temp-idle", group: "temporary" },
    { id: "temp-busy", group: "temporary" },
    { id: "phantom", group: "phantom" },
  ];

  it("hides a temporary car on a day it has no rides, keeps shared/phantom rows and busy temporary cars", () => {
    expect(hideIdleTemporaryCars(cars, [{ carId: "temp-busy" }]).map((c) => c.id)).toEqual(["shared-1", "temp-busy", "phantom"]);
  });

  it("hides every temporary car on a day with no rides at all", () => {
    expect(hideIdleTemporaryCars(cars, []).map((c) => c.id)).toEqual(["shared-1", "phantom"]);
  });

  it("keeps the cars' original order", () => {
    expect(hideIdleTemporaryCars(cars, [{ carId: "temp-idle" }, { carId: "temp-busy" }]).map((c) => c.id))
      .toEqual(["shared-1", "temp-idle", "temp-busy", "phantom"]);
  });
});

describe("carAwayPlaceAtDayStart (R2B14)", () => {
  const names = new Map([["H", "Home"], ["Z", "Zichron"]]);
  const rides = [{ car_id: "c", ends_at: "2026-10-12T10:00:00.000Z", destination_id: "Z", status: "confirmed" }];
  it("names the place only on days the car is still away", () => {
    expect(carAwayPlaceAtDayStart({ carId: "c", dayStartIso: "2026-10-13T00:00:00.000Z", rides, homeId: "H", names })).toBe("Zichron");
    expect(carAwayPlaceAtDayStart({ carId: "c", dayStartIso: "2026-10-12T00:00:00.000Z", rides, homeId: "H", names })).toBeUndefined();
  });
  it("is silent when the car stands at its base", () => {
    expect(carAwayPlaceAtDayStart({ carId: "c", dayStartIso: "2026-10-13T00:00:00.000Z", rides: [], weekStartLocationId: "H", homeId: "H", names })).toBeUndefined();
  });
});
