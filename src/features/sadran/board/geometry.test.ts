import { describe, expect, it } from "vitest";

import {
  isoToMinutesSinceMidnight,
  isoToSlot,
  scanBoardConflicts,
  slotToIso,
  snapMinutesTo15,
  withinFlex,
  wouldOverlap,
} from "./geometry";

const WEEK_START_MS = Date.parse("2026-09-13T00:00:00.000Z");

describe("isoToSlot / slotToIso", () => {
  it("round-trips a 15-minute-aligned timestamp", () => {
    const iso = new Date(WEEK_START_MS + 5 * 15 * 60_000).toISOString();
    expect(isoToSlot(iso, WEEK_START_MS)).toBe(5);
    expect(slotToIso(5, WEEK_START_MS)).toBe(iso);
  });

  it("rounds a near-boundary timestamp to the nearest slot", () => {
    const iso = new Date(WEEK_START_MS + 15 * 60_000 - 10).toISOString();
    expect(isoToSlot(iso, WEEK_START_MS)).toBe(1);
  });
});

describe("isoToMinutesSinceMidnight", () => {
  it("computes minutes since a given day start", () => {
    const dayStart = "2026-09-15T00:00:00.000Z";
    const at = "2026-09-15T08:30:00.000Z";
    expect(isoToMinutesSinceMidnight(at, dayStart)).toBe(510);
  });
});

describe("snapMinutesTo15", () => {
  it("snaps to the nearest quarter hour", () => {
    expect(snapMinutesTo15(7)).toBe(0);
    expect(snapMinutesTo15(8)).toBe(15);
    expect(snapMinutesTo15(97)).toBe(90);
  });
});

describe("withinFlex", () => {
  it("no shift is always within flex", () => {
    expect(withinFlex(0, 0, 0)).toBe(true);
  });
  it("checks earlier/later bounds independently", () => {
    expect(withinFlex(-30, 30, 15)).toBe(true);
    expect(withinFlex(-31, 30, 15)).toBe(false);
    expect(withinFlex(15, 30, 15)).toBe(true);
    expect(withinFlex(16, 30, 15)).toBe(false);
  });
  it("'day' flexibility accepts any shift in that direction", () => {
    expect(withinFlex(-10_000, "day", 0)).toBe(true);
    expect(withinFlex(10_000, 0, "day")).toBe(true);
  });
});

describe("wouldOverlap", () => {
  it("detects overlap within the buffer", () => {
    const candidate = { startsAt: "2026-09-15T08:00:00.000Z", endsAt: "2026-09-15T09:00:00.000Z" };
    const others = [{ startsAt: "2026-09-15T09:10:00.000Z", endsAt: "2026-09-15T10:00:00.000Z" }];
    expect(wouldOverlap(candidate, others, 30)).toBe(true);
    expect(wouldOverlap(candidate, others, 5)).toBe(false);
  });
});

const DAYS = Array.from({ length: 7 }, (_, dayIndex) => ({
  dayIndex: dayIndex as 0 | 1 | 2 | 3 | 4 | 5 | 6,
  startSlot: dayIndex * 96,
  endSlot: dayIndex * 96 + 96,
  dayEndSlot: dayIndex * 96 + 95,
}));

function iso(dayOffsetMs: number): string {
  return new Date(WEEK_START_MS + dayOffsetMs).toISOString();
}

describe("scanBoardConflicts", () => {
  it("flags two overlapping rides on the same car and leaves a non-overlapping ride clean", () => {
    const rides = [
      {
        id: "r1",
        carId: "car-1",
        startsAt: iso(8 * 3600_000),
        endsAt: iso(9 * 3600_000),
        originId: "home",
        destinationId: "home",
        overnightAck: false,
      },
      {
        id: "r2",
        carId: "car-1",
        startsAt: iso(8.5 * 3600_000),
        endsAt: iso(9.5 * 3600_000),
        originId: "home",
        destinationId: "home",
        overnightAck: false,
      },
      {
        id: "r3",
        carId: "car-2",
        startsAt: iso(8 * 3600_000),
        endsAt: iso(9 * 3600_000),
        originId: "home",
        destinationId: "home",
        overnightAck: false,
      },
    ];
    const result = scanBoardConflicts({
      rides,
      carIds: ["car-1", "car-2"],
      weekStartMs: WEEK_START_MS,
      bufferMinutes: 30,
      homeLocationId: "home",
      days: DAYS,
    });
    expect(result.conflictRideIds.has("r1")).toBe(false);
    expect(result.conflictRideIds.has("r2")).toBe(true);
    expect(result.conflictRideIds.has("r3")).toBe(false);
  });

  it("flags a ride starting where the car is not (location mismatch)", () => {
    const rides = [
      {
        id: "r1",
        carId: "car-1",
        startsAt: iso(8 * 3600_000),
        endsAt: iso(9 * 3600_000),
        originId: "away",
        destinationId: "home",
        overnightAck: false,
      },
    ];
    const result = scanBoardConflicts({
      rides,
      carIds: ["car-1"],
      weekStartMs: WEEK_START_MS,
      bufferMinutes: 30,
      homeLocationId: "home",
      days: DAYS,
    });
    expect(result.conflictRideIds.has("r1")).toBe(true);
  });

  it("reports a day-end violation for an un-acknowledged overnight stay", () => {
    const rides = [
      {
        id: "r1",
        carId: "car-1",
        startsAt: iso(22 * 3600_000),
        endsAt: iso(23 * 3600_000),
        originId: "home",
        destinationId: "away",
        overnightAck: false,
      },
    ];
    const result = scanBoardConflicts({
      rides,
      carIds: ["car-1"],
      weekStartMs: WEEK_START_MS,
      bufferMinutes: 30,
      homeLocationId: "home",
      days: DAYS,
    });
    expect(result.dayEndViolationsByCarId.get("car-1")?.length).toBeGreaterThan(0);
    expect(result.awayByCarId.get("car-1")?.some((a) => a.locationId === "away")).toBe(true);
  });

  it("does not flag an acknowledged overnight stay", () => {
    const rides = [
      {
        id: "r1",
        carId: "car-1",
        startsAt: iso(22 * 3600_000),
        endsAt: iso(23 * 3600_000),
        originId: "home",
        destinationId: "away",
        overnightAck: true,
      },
    ];
    const result = scanBoardConflicts({
      rides,
      carIds: ["car-1"],
      weekStartMs: WEEK_START_MS,
      bufferMinutes: 30,
      homeLocationId: "home",
      days: DAYS,
    });
    expect(result.dayEndViolationsByCarId.get("car-1")?.length).toBe(0);
  });
});
