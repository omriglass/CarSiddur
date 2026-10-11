import { describe, expect, it } from "vitest";

import { addDaysToKey, daySegments, minutesOfDay, weekDayKeys } from "./dayColumns";

describe("weekDayKeys", () => {
  it("lists Sunday to Saturday", () => {
    expect(weekDayKeys("2026-10-11")).toEqual(["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
  });

  it("crosses the October DST end (2026-10-25) without skipping or repeating a date", () => {
    expect(weekDayKeys("2026-10-25")).toEqual(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
    expect(addDaysToKey("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("minutesOfDay", () => {
  it("reads Jerusalem wall-clock time, not the device's (summer UTC+3)", () => {
    expect(minutesOfDay("2026-10-12T05:30:00Z")).toBe(8 * 60 + 30);
  });
});

describe("daySegments", () => {
  const week = weekDayKeys("2026-10-11");

  it("returns one segment for a same-day span", () => {
    expect(daySegments("2026-10-12T05:00:00Z", "2026-10-12T09:15:00Z", week)).toEqual([{ dayKey: "2026-10-12", startMinutes: 8 * 60, endMinutes: 12 * 60 + 15 }]);
  });

  it("gives a single-time item the fallback length", () => {
    expect(daySegments("2026-10-12T05:00:00Z", null, week, 45)).toEqual([{ dayKey: "2026-10-12", startMinutes: 480, endMinutes: 525 }]);
  });

  it("splits a span over midnight into one segment per day", () => {
    // 22:00 Jerusalem on the 12th until 01:00 on the 13th.
    expect(daySegments("2026-10-12T19:00:00Z", "2026-10-12T22:00:00Z", week)).toEqual([
      { dayKey: "2026-10-12", startMinutes: 22 * 60, endMinutes: 1440 },
      { dayKey: "2026-10-13", startMinutes: 0, endMinutes: 60 },
    ]);
  });

  it("ends exactly at midnight on the first day without an empty second segment", () => {
    expect(daySegments("2026-10-12T19:00:00Z", "2026-10-12T21:00:00Z", week)).toEqual([{ dayKey: "2026-10-12", startMinutes: 22 * 60, endMinutes: 1440 }]);
  });

  it("drops days outside the week", () => {
    // Saturday 23:00 into next Sunday 01:00: only Saturday remains.
    expect(daySegments("2026-10-17T20:00:00Z", "2026-10-17T22:00:00Z", week)).toEqual([{ dayKey: "2026-10-17", startMinutes: 23 * 60, endMinutes: 1440 }]);
  });

  it("returns nothing for an unparseable start", () => {
    expect(daySegments("nope", null, week)).toEqual([]);
  });
});
