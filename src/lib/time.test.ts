import { formatInTimeZone } from "date-fns-tz";
import { describe, expect, it } from "vitest";

import { TZ, dateKey, formatTime, weekStartFor, weekdayIndex } from "./time";

function localTime(instant: Date): string {
  return formatInTimeZone(instant, TZ, "yyyy-MM-dd HH:mm");
}

describe("weekStartFor", () => {
  it("returns the local Sunday midnight for an ordinary week", () => {
    const wednesday = new Date("2027-01-13T10:00:00Z");
    expect(localTime(weekStartFor(wednesday))).toBe("2027-01-10 00:00");
  });

  it("is stable across the Asia/Jerusalem spring-forward transition (2027-03-26)", () => {
    // Israel moves clocks forward at local 02:00 on the Friday before the
    // last Sunday of March; in 2027 that instant is 2027-03-26T00:00:00Z.
    const beforeTransition = new Date("2027-03-25T21:37:00Z"); // Thu 23:37 IST (UTC+2)
    const afterTransition = new Date("2027-03-26T10:37:00Z"); // Fri 13:37 IDT (UTC+3)

    expect(localTime(weekStartFor(beforeTransition))).toBe("2027-03-21 00:00");
    expect(localTime(weekStartFor(afterTransition))).toBe("2027-03-21 00:00");
  });

  it("is stable across the Asia/Jerusalem fall-back transition (2027-10-31)", () => {
    // Israel moves clocks back at local 02:00 on the last Sunday of
    // October; in 2027 that instant is 2027-10-30T23:00:00Z.
    const beforeTransition = new Date("2027-10-30T21:37:00Z"); // Sun 00:37 IDT (UTC+3)
    const afterTransition = new Date("2027-11-03T10:37:00Z"); // Wed 12:37 IST (UTC+2)

    expect(localTime(weekStartFor(beforeTransition))).toBe("2027-10-31 00:00");
    expect(localTime(weekStartFor(afterTransition))).toBe("2027-10-31 00:00");
  });
});

describe("formatTime", () => {
  it("formats an instant as local HH:mm", () => {
    expect(formatTime(new Date("2027-01-13T10:06:00Z"))).toBe("12:06");
  });
});

describe("dateKey", () => {
  it("formats an instant as the local yyyy-MM-dd day bucket", () => {
    // 2027-01-13T22:30:00Z is already 2027-01-14 00:30 in Asia/Jerusalem.
    expect(dateKey(new Date("2027-01-13T22:30:00Z"))).toBe("2027-01-14");
  });

  it("accepts an ISO string directly", () => {
    expect(dateKey("2027-01-13T10:06:00Z")).toBe("2027-01-13");
  });
});

describe("weekdayIndex", () => {
  it("returns 0 for a local Sunday and 6 for a local Saturday", () => {
    // 2027-01-10 is a Sunday in Asia/Jerusalem.
    expect(weekdayIndex(new Date("2027-01-10T10:00:00Z"))).toBe(0);
    // 2027-01-16 is a Saturday in Asia/Jerusalem.
    expect(weekdayIndex(new Date("2027-01-16T10:00:00Z"))).toBe(6);
  });

  it("crosses local midnight correctly, not UTC midnight", () => {
    // 2027-01-16T22:30:00Z is already Sunday 2027-01-17 00:30 in Asia/Jerusalem.
    expect(weekdayIndex(new Date("2027-01-16T22:30:00Z"))).toBe(0);
  });
});

describe("wall-clock helpers match date-fns-tz (O28-8 cached formatter)", () => {
  // Every 15 minutes across both 2026 switches (27.3 spring forward, 25.10 fall back) and an ordinary day.
  const days = ["2026-03-26T18:00:00Z", "2026-10-24T18:00:00Z", "2026-11-01T18:00:00Z"];
  const instants = days.flatMap((start) =>
    Array.from({ length: 4 * 36 }, (_, i) => new Date(Date.parse(start) + i * 15 * 60_000)),
  );

  it("dateKey, weekdayIndex and formatTime agree for Date, number and ISO-string input", () => {
    for (const instant of instants) {
      const iso = instant.toISOString();
      const expectedKey = formatInTimeZone(instant, TZ, "yyyy-MM-dd");
      expect(dateKey(instant)).toBe(expectedKey);
      expect(dateKey(instant.getTime())).toBe(expectedKey);
      expect(dateKey(iso)).toBe(expectedKey);
      expect(dateKey(iso.replace("Z", "+00:00"))).toBe(expectedKey);
      expect(weekdayIndex(iso)).toBe(Number(formatInTimeZone(instant, TZ, "i")) % 7);
      expect(formatTime(instant)).toBe(formatInTimeZone(instant, TZ, "HH:mm"));
    }
  });

  it("still refuses an invalid instant", () => {
    expect(() => dateKey("not a date")).toThrow(RangeError);
  });
});
