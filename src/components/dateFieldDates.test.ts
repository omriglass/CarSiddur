import { describe, expect, it } from "vitest";

import { datesFrom, datesOfWeek, formatWeekRangeLabel } from "./dateFieldDates";

describe("formatWeekRangeLabel", () => {
  it("includes the month on both ends of an RTL week range", () => {
    expect(formatWeekRangeLabel("2026-09-06")).toBe("6.9 – 12.9");
  });
});

describe("datesFrom", () => {
  it("returns count consecutive dates starting at start, crossing a week/month boundary", () => {
    expect(datesFrom("2026-09-13", 14)).toEqual([
      "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19",
      "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26",
    ]);
  });

  it("agrees with datesOfWeek for a plain 7-day span", () => {
    expect(datesFrom("2026-09-13", 7)).toEqual(datesOfWeek("2026-09-13"));
  });
});

describe("datesOfWeek", () => {
  it("returns the 7 dates of the week starting at weekStart", () => {
    // 2026-09-06 is a Sunday.
    expect(datesOfWeek("2026-09-06")).toEqual([
      "2026-09-06",
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
    ]);
  });

  it("crosses a month boundary correctly", () => {
    const dates = datesOfWeek("2026-09-27");
    expect(dates[0]).toBe("2026-09-27");
    expect(dates[6]).toBe("2026-10-03");
  });
});
