import { describe, expect, it } from "vitest";

import { computePresetRange, normalizeStatsRange } from "./presets";

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

  it("clamps the computed start to `earliest` when the preset would start earlier", () => {
    // last4Weeks would normally start 2026-08-13; the department has no data before 2026-09-01.
    expect(computePresetRange("last4Weeks", TODAY, "2026-09-01")).toEqual({ from: "2026-09-01", to: TODAY });
    expect(computePresetRange("last3Months", TODAY, "2026-09-01")).toEqual({ from: "2026-09-01", to: TODAY });
    expect(computePresetRange("thisYear", TODAY, "2026-09-01")).toEqual({ from: "2026-09-01", to: TODAY });
  });

  it("leaves the computed start untouched when it already falls after `earliest`", () => {
    expect(computePresetRange("last4Weeks", TODAY, "2026-01-01")).toEqual({ from: "2026-08-13", to: TODAY });
  });

  it("ignores a null/undefined earliest (unknown yet)", () => {
    expect(computePresetRange("last4Weeks", TODAY, null)).toEqual({ from: "2026-08-13", to: TODAY });
    expect(computePresetRange("last4Weeks", TODAY, undefined)).toEqual({ from: "2026-08-13", to: TODAY });
  });
});

describe("normalizeStatsRange (R17B12)", () => {
  it("clamps a future bound to today and never leaves from after to", () => {
    expect(normalizeStatsRange({ from: "2026-11-08", to: "2026-11-14" }, "2026-11-01", "from")).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(normalizeStatsRange({ from: "2026-10-20", to: "2026-10-10" }, "2026-11-01", "to")).toEqual({ from: "2026-10-10", to: "2026-10-10" });
    expect(normalizeStatsRange({ from: "2026-10-20", to: "2026-10-10" }, "2026-11-01", "from")).toEqual({ from: "2026-10-20", to: "2026-10-20" });
    expect(normalizeStatsRange({ from: "2026-10-01", to: "2026-10-10" }, "2026-11-01", "to")).toEqual({ from: "2026-10-01", to: "2026-10-10" });
  });
});
