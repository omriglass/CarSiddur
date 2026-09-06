import { describe, expect, it } from "vitest";

import { clampPassengerField } from "./PassengerStepper";

describe("clampPassengerField", () => {
  it("keeps adults at 1 or above (the driver always counts)", () => {
    expect(clampPassengerField("adults", 0)).toBe(1);
    expect(clampPassengerField("adults", -5)).toBe(1);
  });

  it("allows childSeats/boosters down to 0", () => {
    expect(clampPassengerField("childSeats", -1)).toBe(0);
    expect(clampPassengerField("boosters", -1)).toBe(0);
  });

  it("caps every field at 8", () => {
    expect(clampPassengerField("adults", 20)).toBe(8);
    expect(clampPassengerField("childSeats", 9)).toBe(8);
    expect(clampPassengerField("boosters", 100)).toBe(8);
  });

  it("passes through in-range values unchanged", () => {
    expect(clampPassengerField("adults", 3)).toBe(3);
    expect(clampPassengerField("childSeats", 2)).toBe(2);
  });
});
