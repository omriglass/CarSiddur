import { describe, expect, it } from "vitest";

import { dayOfWeekOfKey, isRushDay, rushWindowsForDay, stretchedMinutesFrom, stretchedMinutesUntil, type RushSettings } from "./rushHours";

const SETTINGS: RushSettings = {
  rush_morning_start: "07:00:00",
  rush_morning_end: "09:30:00",
  rush_morning_percent: 30,
  rush_afternoon_start: "15:30:00",
  rush_afternoon_end: "18:30:00",
  rush_afternoon_percent: 20,
};
const SUN = "2026-10-11";
const THU = "2026-10-15";
const FRI = "2026-10-16";
const SAT = "2026-10-17";
const h = (hh: number, mm = 0) => hh * 60 + mm;

describe("rushWindowsForDay", () => {
  it("Sunday to Thursday have both windows, Friday and Saturday none", () => {
    expect(dayOfWeekOfKey(SUN)).toBe(0);
    expect(isRushDay(THU)).toBe(true);
    expect(isRushDay(FRI)).toBe(false);
    expect(isRushDay(SAT)).toBe(false);
    expect(rushWindowsForDay(SETTINGS, SUN)).toEqual([
      { startMinutes: h(7), endMinutes: h(9, 30), percent: 30 },
      { startMinutes: h(15, 30), endMinutes: h(18, 30), percent: 20 },
    ]);
    expect(rushWindowsForDay(SETTINGS, THU)).toHaveLength(2);
    expect(rushWindowsForDay(SETTINGS, FRI)).toEqual([]);
    expect(rushWindowsForDay(SETTINGS, SAT)).toEqual([]);
  });

  it("drops a 0 % window and tolerates missing settings or day", () => {
    expect(rushWindowsForDay({ ...SETTINGS, rush_morning_percent: 0 }, SUN)).toHaveLength(1);
    expect(rushWindowsForDay(undefined, SUN)).toEqual([]);
    expect(rushWindowsForDay(SETTINGS, undefined)).toEqual([]);
  });
});

describe("stretchedMinutesUntil (drive ends at a given minute)", () => {
  const w = rushWindowsForDay(SETTINGS, SUN);

  it("no overlap: the plain drive", () => {
    expect(stretchedMinutesUntil(h(13), 60, w)).toBe(60);
    expect(stretchedMinutesUntil(h(11), 60, w)).toBe(60);
    expect(stretchedMinutesUntil(h(6, 30), 30, w)).toBe(30);
  });

  it("full overlap: the whole drive grows by the percentage", () => {
    expect(stretchedMinutesUntil(h(9), 60, w)).toBeCloseTo(78, 6);
    expect(stretchedMinutesUntil(h(18), 50, w)).toBeCloseTo(60, 6);
  });

  it("partial overlap: only the part inside the window grows", () => {
    // arrive 10:00, 60 base: 30 min outside (09:30-10:00), 30 base min inside = 39 clock min.
    expect(stretchedMinutesUntil(h(10), 60, w)).toBeCloseTo(69, 6);
    // drive that starts before the window: arrive 07:30, 60 base. Inside: 30 clock min = 23.077 base.
    expect(stretchedMinutesUntil(h(7, 30), 60, w)).toBeCloseTo(30 + (60 - 30 / 1.3), 6);
  });

  it("both windows in one drive", () => {
    // arrive 19:00 with a very long drive reaching back across the afternoon window into the gap.
    const total = stretchedMinutesUntil(h(19), 300, w);
    // 30 outside (18:30-19:00) + 180 clock min inside = 138.46 base + rest outside.
    expect(total).toBeCloseTo(30 + 180 + (300 - 30 - 180 / 1.2), 6);
    // from 19:00 back to 07:00 morning window: 300 base consumes the afternoon window, the gap, and nothing more.
    const long = stretchedMinutesUntil(h(10), 600, w);
    expect(long).toBeGreaterThan(600);
  });
});

describe("stretchedMinutesFrom (drive starts at a given minute)", () => {
  const w = rushWindowsForDay(SETTINGS, SUN);

  it("no overlap, full overlap, partial overlap", () => {
    expect(stretchedMinutesFrom(h(10), 60, w)).toBe(60);
    expect(stretchedMinutesFrom(h(16), 60, w)).toBeCloseTo(72, 6);
    // leave 18:00, 60 base: 30 clock min inside = 25 base, 35 outside.
    expect(stretchedMinutesFrom(h(18), 60, w)).toBeCloseTo(30 + 35, 6);
  });

  it("starts before a window and runs into it", () => {
    // leave 06:30, 60 base: 30 outside, 30 base inside = 39.
    expect(stretchedMinutesFrom(h(6, 30), 60, w)).toBeCloseTo(69, 6);
  });

  it("a window boundary start is inside (start) / outside (end)", () => {
    expect(stretchedMinutesFrom(h(9, 30), 30, w)).toBe(30);
    expect(stretchedMinutesFrom(h(7), 13, w)).toBeCloseTo(16.9, 6);
  });

  it("no windows leaves any drive plain", () => {
    expect(stretchedMinutesFrom(h(8), 45, [])).toBe(45);
    expect(stretchedMinutesUntil(h(8), 45, [])).toBe(45);
  });
});
