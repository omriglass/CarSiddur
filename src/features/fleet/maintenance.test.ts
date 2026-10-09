import { describe, expect, it } from "vitest";

import { canEditMaintenance, formatMaintenanceRange, maintenanceDaySlice, nextMaintenance, shiftMaintenance } from "./maintenance";

const block = (id: string, car: string, s: string, e: string) => ({ id, car_id: car, starts_at: s, ends_at: e, reason: "x" });

describe("nextMaintenance", () => {
  const now = Date.parse("2026-11-01T08:00:00Z");
  it("picks the earliest period that has not ended, a running one included", () => {
    const blocks = [
      block("past", "c1", "2026-10-01T08:00:00Z", "2026-10-02T08:00:00Z"),
      block("late", "c1", "2026-11-12T08:00:00Z", "2026-11-12T17:00:00Z"),
      block("running", "c1", "2026-11-01T06:00:00Z", "2026-11-01T10:00:00Z"),
      block("other", "c2", "2026-11-02T06:00:00Z", "2026-11-02T10:00:00Z"),
    ];
    expect(nextMaintenance(blocks, "c1", now)?.id).toBe("running");
    expect(nextMaintenance(blocks.filter((b) => b.id !== "running"), "c1", now)?.id).toBe("late");
    expect(nextMaintenance(blocks, "c3", now)).toBeUndefined();
  });
});

describe("formatMaintenanceRange", () => {
  it("one day: weekday + date + times in Jerusalem time", () => {
    // 2026-11-12 is a Thursday; 08:00Z = 10:00 Jerusalem (IST, UTC+2).
    expect(formatMaintenanceRange("2026-11-12T08:00:00Z", "2026-11-12T17:00:00Z")).toBe("ה׳ 12.11 \u206610:00–19:00\u2069");
  });
  it("several days: both ends carry their weekday and date", () => {
    expect(formatMaintenanceRange("2026-11-12T08:00:00Z", "2026-11-14T17:00:00Z")).toBe("ה׳ 12.11 \u206610:00\u2069 – ש׳ 14.11 \u206619:00\u2069");
  });
});

describe("maintenanceDaySlice", () => {
  const p = { starts_at: "2026-11-12T08:00:00Z", ends_at: "2026-11-14T17:00:00Z" }; // 10:00 on the 12th -> 19:00 on the 14th, Jerusalem
  it("clips a multi-day period per day", () => {
    expect(maintenanceDaySlice(p, "2026-11-11")).toBeNull();
    expect(maintenanceDaySlice(p, "2026-11-12")).toEqual({ startMinutes: 600, endMinutes: 4020, clippedStart: false, clippedEnd: true });
    expect(maintenanceDaySlice(p, "2026-11-13")).toEqual({ startMinutes: -840, endMinutes: 2580, clippedStart: true, clippedEnd: true });
    expect(maintenanceDaySlice(p, "2026-11-14")).toEqual({ startMinutes: -2280, endMinutes: 1140, clippedStart: true, clippedEnd: false });
    expect(maintenanceDaySlice(p, "2026-11-15")).toBeNull();
  });
  it("a period ending exactly at midnight does not touch the next day", () => {
    expect(maintenanceDaySlice({ starts_at: "2026-11-12T08:00:00Z", ends_at: "2026-11-12T22:00:00Z" }, "2026-11-13")).toBeNull();
  });
});

describe("shiftMaintenance", () => {
  const p = { starts_at: "2026-11-12T08:00:00Z", ends_at: "2026-11-12T17:00:00Z" };
  it("moves both edges", () => {
    expect(shiftMaintenance(p, "move", 60)).toEqual({ startsAt: "2026-11-12T09:00:00.000Z", endsAt: "2026-11-12T18:00:00.000Z" });
  });
  it("resizes one edge", () => {
    expect(shiftMaintenance(p, "end", -120).endsAt).toBe("2026-11-12T15:00:00.000Z");
    expect(shiftMaintenance(p, "start", 30).startsAt).toBe("2026-11-12T08:30:00.000Z");
  });
  it("never shrinks below 15 minutes", () => {
    expect(shiftMaintenance(p, "end", -10_000)).toEqual({ startsAt: "2026-11-12T08:00:00.000Z", endsAt: "2026-11-12T08:15:00.000Z" });
    expect(shiftMaintenance(p, "start", 10_000)).toEqual({ startsAt: "2026-11-12T16:45:00.000Z", endsAt: "2026-11-12T17:00:00.000Z" });
  });
});

describe("canEditMaintenance", () => {
  it("admin, department Sadran, or the car's current responsible person", () => {
    expect(canEditMaintenance({ isAdmin: true, isDepartmentSadran: false, profileId: "a", carResponsibleId: null })).toBe(true);
    expect(canEditMaintenance({ isAdmin: false, isDepartmentSadran: true, profileId: "a", carResponsibleId: null })).toBe(true);
    expect(canEditMaintenance({ isAdmin: false, isDepartmentSadran: false, profileId: "a", carResponsibleId: "a" })).toBe(true);
  });
  it("nobody else", () => {
    expect(canEditMaintenance({ isAdmin: false, isDepartmentSadran: false, profileId: "a", carResponsibleId: "b" })).toBe(false);
    expect(canEditMaintenance({ isAdmin: false, isDepartmentSadran: false, profileId: "a", carResponsibleId: null })).toBe(false);
    expect(canEditMaintenance({ isAdmin: false, isDepartmentSadran: false, profileId: undefined, carResponsibleId: undefined })).toBe(false);
  });
});
