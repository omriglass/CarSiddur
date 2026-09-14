import { describe, expect, it } from "vitest";

import { visibleSiddurCars } from "./visibleCars";

describe("visibleSiddurCars", () => {
  const cars = [
    { id: "shared-1", group: "shared" },
    { id: "temp-idle", group: "temporary" },
    { id: "temp-busy", group: "temporary" },
    { id: "phantom", group: "phantom" },
  ];

  it("hides a temporary car on a day it has no rides, keeps shared/phantom rows and busy temporary cars", () => {
    expect(visibleSiddurCars(cars, [{ carId: "temp-busy" }]).map((c) => c.id)).toEqual(["shared-1", "temp-busy", "phantom"]);
  });

  it("hides every temporary car on a day with no rides at all", () => {
    expect(visibleSiddurCars(cars, []).map((c) => c.id)).toEqual(["shared-1", "phantom"]);
  });

  it("keeps the cars' original order", () => {
    expect(visibleSiddurCars(cars, [{ carId: "temp-idle" }, { carId: "temp-busy" }]).map((c) => c.id))
      .toEqual(["shared-1", "temp-idle", "temp-busy", "phantom"]);
  });
});
