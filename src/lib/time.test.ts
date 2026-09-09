import { formatInTimeZone } from "date-fns-tz";
import { describe, expect, it } from "vitest";

import { TZ, dateKey, formatTime, roundTo15, weekStartFor, weekdayIndex } from "./time";

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

describe("roundTo15", () => {
  it("rounds down when closer to the previous quarter hour", () => {
    const instant = new Date("2027-01-13T10:06:00Z");
    expect(localTime(roundTo15(instant))).toBe("2027-01-13 12:00");
  });

  it("rounds up when closer to the next quarter hour", () => {
    const instant = new Date("2027-01-13T10:09:00Z");
    expect(localTime(roundTo15(instant))).toBe("2027-01-13 12:15");
  });

  it("rounds correctly on both sides of the spring-forward transition", () => {
    const beforeTransition = new Date("2027-03-25T23:53:00Z"); // 01:53 IST -> 02:00
    const afterTransition = new Date("2027-03-26T00:07:00Z"); // 03:07 IDT -> 03:00

    // 01:53 IST rounds up to the nominal wall-clock 02:00, but 02:00-03:00
    // never occurs locally on transition day (clocks jump straight from
    // 01:59:59 IST to 03:00:00 IDT), so the DST-safe result normalizes
    // forward past the gap instead of producing an impossible local time.
    expect(localTime(roundTo15(beforeTransition))).toBe("2027-03-26 03:00");
    expect(localTime(roundTo15(afterTransition))).toBe("2027-03-26 03:00");
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
