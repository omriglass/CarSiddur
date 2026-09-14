import { describe, expect, it } from "vitest";

import { hideIdleTemporaryCars } from "./weekGridCars";

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
