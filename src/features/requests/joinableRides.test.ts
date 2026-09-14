import { describe, expect, it } from "vitest";

import { joinableRideDriverLabel } from "./joinableRides";

describe("joinableRideDriverLabel", () => {
  it("prefers the driver's name when the ride already has one", () => {
    expect(joinableRideDriverLabel({ driverName: "יואב", carName: "יונדאי 1" })).toBe("יואב");
  });

  it("falls back to the car's name for a still-unclaimed (driverless) ride", () => {
    expect(joinableRideDriverLabel({ driverName: "", carName: "יונדאי 1" })).toBe("יונדאי 1");
  });
});
