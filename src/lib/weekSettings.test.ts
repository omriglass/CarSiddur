import { describe, expect, it } from "vitest";
import { effectiveWeekSettings } from "./weekSettings";

describe("effectiveWeekSettings", () => {
  const dept = { turnaround_minutes: 45, chauffeur_dwell_minutes: 15 };

  it("uses the department settings when the week has no override", () => {
    expect(effectiveWeekSettings(dept, { settings_overrides: {} })).toEqual({ turnaroundMinutes: 45, chauffeurDwellMinutes: 15 });
    expect(effectiveWeekSettings(dept, null)).toEqual({ turnaroundMinutes: 45, chauffeurDwellMinutes: 15 });
  });

  it("lets the week override win, per key", () => {
    expect(effectiveWeekSettings(dept, { settings_overrides: { turnaround_minutes: 60 } })).toEqual({ turnaroundMinutes: 60, chauffeurDwellMinutes: 15 });
    expect(effectiveWeekSettings(dept, { settings_overrides: { chauffeur_dwell_minutes: 0, turnaround_minutes: 0 } })).toEqual({ turnaroundMinutes: 0, chauffeurDwellMinutes: 0 });
  });

  it("falls back to 30 / 10 when nothing is loaded yet", () => {
    expect(effectiveWeekSettings(undefined, undefined)).toEqual({ turnaroundMinutes: 30, chauffeurDwellMinutes: 10 });
    expect(effectiveWeekSettings({ turnaround_minutes: null }, undefined).turnaroundMinutes).toBe(30);
  });

  it("ignores junk overrides, accepts numeric strings like the SQL ::int cast", () => {
    expect(effectiveWeekSettings(dept, { settings_overrides: [60] }).turnaroundMinutes).toBe(45);
    expect(effectiveWeekSettings(dept, { settings_overrides: { turnaround_minutes: "abc" } }).turnaroundMinutes).toBe(45);
    expect(effectiveWeekSettings(dept, { settings_overrides: { turnaround_minutes: null } }).turnaroundMinutes).toBe(45);
    expect(effectiveWeekSettings(dept, { settings_overrides: { turnaround_minutes: "60" } }).turnaroundMinutes).toBe(60);
  });
});
