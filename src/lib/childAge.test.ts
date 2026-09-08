import { describe, expect, it } from "vitest";

import { ageFromBirthYear, isAdultPassenger } from "./childAge";

describe("child passenger age", () => {
  it("calculates age from the recorded birth year", () => {
    expect(ageFromBirthYear(2019, 2026)).toBe(7);
    expect(ageFromBirthYear(null, 2026)).toBeNull();
  });

  it("counts a child as an adult passenger from age eight", () => {
    expect(isAdultPassenger(2018, 2026)).toBe(true);
    expect(isAdultPassenger(2019, 2026)).toBe(false);
  });
});
