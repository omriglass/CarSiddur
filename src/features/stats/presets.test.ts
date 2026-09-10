import { describe, expect, it } from "vitest";

import { computePresetRange } from "./presets";

const TODAY = "2026-09-10";

describe("computePresetRange", () => {
  it("last4Weeks: 28 days back, ending today", () => {
    expect(computePresetRange("last4Weeks", TODAY)).toEqual({ from: "2026-08-13", to: TODAY });
  });

  it("last3Months: 3 calendar months back, ending today", () => {
    expect(computePresetRange("last3Months", TODAY)).toEqual({ from: "2026-06-10", to: TODAY });
  });

  it("thisYear: January 1st of the current year, ending today", () => {
    expect(computePresetRange("thisYear", TODAY)).toEqual({ from: "2026-01-01", to: TODAY });
  });

  it("is pure: same inputs produce the same output", () => {
    expect(computePresetRange("last4Weeks", TODAY)).toEqual(computePresetRange("last4Weeks", TODAY));
  });
});
