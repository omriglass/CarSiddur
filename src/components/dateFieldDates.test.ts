import { describe, expect, it } from "vitest";

import { calendarCells, datesFrom, datesOfWeek, formatWeekRangeLabel, weekdayOfDate } from "./dateFieldDates";

describe("formatWeekRangeLabel", () => {
  it("reads start-to-end as one left-to-right isolate, month once when it is the same", () => {
    expect(formatWeekRangeLabel("2026-09-06")).toBe("\u20666–12.9\u2069");
  });

  it("keeps both months when the week crosses a month boundary", () => {
    expect(formatWeekRangeLabel("2026-09-27")).toBe("\u206627.9–3.10\u2069");
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

describe("calendarCells", () => {
  it("a plain Sunday week is one row with nothing greyed", () => {
    const cells = calendarCells("2026-10-11", 7);
    expect(cells.map((c) => c.date)).toEqual(datesOfWeek("2026-10-11"));
    expect(cells.every((c) => c.selectable)).toBe(true);
  });

  it("a range starting on a Friday greys Sunday–Thursday before it and pads the last week (owner 2026-10-13)", () => {
    // 2026-10-16 is a Friday.
    expect(weekdayOfDate("2026-10-16")).toBe(5);
    const cells = calendarCells("2026-10-16", 13);
    expect(cells).toHaveLength(21);
    expect(cells[0]).toEqual({ date: "2026-10-11", selectable: false });
    expect(cells.slice(0, 5).every((c) => !c.selectable)).toBe(true);
    expect(cells[5]).toEqual({ date: "2026-10-16", selectable: true });
    expect(cells[17]).toEqual({ date: "2026-10-28", selectable: true });
    expect(cells.slice(18).every((c) => !c.selectable)).toBe(true);
    expect(weekdayOfDate(cells[7]!.date)).toBe(0);
  });
});
