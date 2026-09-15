import { describe, expect, it } from "vitest";

import { formatDayDate, weekdayLabel } from "./dayLabels";

describe("weekdayLabel", () => {
  it("returns the long Hebrew weekday name by default", () => {
    // 2027-01-10 is a Sunday in Asia/Jerusalem.
    expect(weekdayLabel(new Date("2027-01-10T10:00:00Z"))).toBe("ראשון");
  });

  it("returns the short Hebrew weekday name when asked", () => {
    expect(weekdayLabel(new Date("2027-01-10T10:00:00Z"), "short")).toBe("א");
  });

  it("accepts an ISO string directly", () => {
    // 2027-01-16 is a Saturday in Asia/Jerusalem.
    expect(weekdayLabel("2027-01-16T10:00:00Z")).toBe("שבת");
  });
});

describe("formatDayDate", () => {
  it("renders a short weekday letter, geresh and d.M (Wednesday)", () => {
    // 2026-09-16T10:00:00+03:00 is a Wednesday in Asia/Jerusalem.
    const result = formatDayDate("2026-09-16T10:00:00+03:00");
    expect(result.startsWith("ד")).toBe(true);
    expect(result.endsWith(" 16.9")).toBe(true);
    expect(result).toBe("ד׳ 16.9");
  });

  it("uses the Asia/Jerusalem calendar day, not the UTC one", () => {
    // 2026-09-16T22:30:00Z is 2026-09-17T01:30:00 in Asia/Jerusalem (Thursday).
    expect(formatDayDate("2026-09-16T22:30:00Z")).toBe("ה׳ 17.9");
  });
});
