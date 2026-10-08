import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import {
  defaultWindowFromFixed,
  intervalMinutes,
  slackInterval,
  windowCarTimes,
  windowEndKeepingSlack,
  windowFromStored,
  windowHoursLabel,
  windowModeActive,
  windowOffered,
  windowProblem,
  windowSummary,
} from "./timeWindow";

const SCOPE = { tripType: "round_trip", tripShape: "round_trip", day: "2026-10-13" };

describe("windowModeActive / windowOffered", () => {
  it("needs the window mode and a single-day round trip", () => {
    expect(windowModeActive({ ...SCOPE, timeMode: "window" })).toBe(true);
    expect(windowModeActive({ ...SCOPE, timeMode: "fixed" })).toBe(false);
    expect(windowModeActive({ ...SCOPE })).toBe(false);
    expect(windowModeActive({ ...SCOPE, timeMode: "window", tripType: "one_way", tripShape: "one_way_to" })).toBe(false);
    expect(windowModeActive({ ...SCOPE, timeMode: "window", tripType: "drop_off", tripShape: "round_trip" })).toBe(false);
    expect(windowModeActive({ ...SCOPE, timeMode: "window", returnDay: "2026-10-14" })).toBe(false);
    expect(windowModeActive({ ...SCOPE, timeMode: "window", returnDay: "2026-10-13" })).toBe(true);
  });
  it("offers the link only where a window can apply", () => {
    expect(windowOffered(SCOPE)).toBe(true);
    expect(windowOffered({ ...SCOPE, tripType: "one_way" })).toBe(false);
    expect(windowOffered({ ...SCOPE, returnDay: "2026-10-15" })).toBe(false);
  });
});

describe("windowProblem / windowCarTimes", () => {
  it("07:00-12:00 for 4 hours leaves one hour of slack", () => {
    const fields = { windowHours: 4, windowStart: "07:00", windowEnd: "12:00" };
    expect(windowProblem(fields)).toBeNull();
    expect(windowCarTimes(fields)).toEqual({ departTime: "07:00", returnTime: "11:00", slackMinutes: 60 });
  });
  it("a window exactly as long as the block has no slack but is valid", () => {
    expect(windowCarTimes({ windowHours: 5, windowStart: "07:00", windowEnd: "12:00" })).toEqual({ departTime: "07:00", returnTime: "12:00", slackMinutes: 0 });
  });
  it("a window shorter than the time needed is refused", () => {
    expect(windowProblem({ windowHours: 6, windowStart: "07:00", windowEnd: "12:00" })).toBe("tooShort");
    expect(windowCarTimes({ windowHours: 6, windowStart: "07:00", windowEnd: "12:00" })).toBeNull();
  });
  it("missing fields are a problem", () => {
    expect(windowProblem({ windowHours: 4, windowStart: "07:00" })).toBe("missing");
    expect(windowProblem({})).toBe("missing");
  });
});

describe("slackInterval / intervalMinutes", () => {
  it("round-trips quarter hours", () => {
    expect(slackInterval(195)).toBe("03:15:00");
    expect(slackInterval(0)).toBe("00:00:00");
    expect(intervalMinutes("03:15:00")).toBe(195);
    expect(intervalMinutes("1 day")).toBe(1440);
    expect(intervalMinutes(null)).toBe(0);
  });
});

describe("defaultWindowFromFixed / windowEndKeepingSlack", () => {
  it("takes the typed length (whole hours) and ends two hours after the block", () => {
    expect(defaultWindowFromFixed({ departTime: "08:00", returnTime: "11:00" })).toEqual({ windowHours: 3, windowStart: "08:00", windowEnd: "13:00" });
  });
  it("falls back to 4 hours for an unusable length and caps at the last quarter hour", () => {
    expect(defaultWindowFromFixed({ departTime: "08:00", returnTime: "08:15" }).windowHours).toBe(4);
    expect(defaultWindowFromFixed({ departTime: "21:00", returnTime: "23:00" }).windowEnd).toBe("23:45");
    expect(defaultWindowFromFixed({}).windowStart).toBe("08:00");
  });
  it("keeps the slack when the start moves", () => {
    const before = { windowHours: 4, windowStart: "07:00", windowEnd: "12:00" };
    expect(windowEndKeepingSlack(before, { windowHours: 4, windowStart: "08:00" })).toBe("13:00");
    expect(windowEndKeepingSlack(before, { windowHours: 3, windowStart: "07:00" })).toBe("11:00");
    expect(windowEndKeepingSlack(before, { windowHours: 4, windowStart: "20:00" })).toBe("23:45");
  });
});

describe("windowFromStored / windowSummary", () => {
  const row = { durationLocked: true, departAt: "2026-10-13T04:00:00Z", returnAt: "2026-10-13T08:00:00Z", flexReturnLate: "01:00:00" };
  const timeOf = (instant: string) => (instant.includes("04:00") ? "07:00" : "11:00");
  it("reads the window back: block 07:00-11:00 plus 1 h slack = a 07:00-12:00 window of 4 hours", () => {
    expect(windowFromStored(row, timeOf)).toEqual({ windowHours: 4, windowStart: "07:00", windowEnd: "12:00" });
  });
  it("is not a window when unlocked or the length is not a whole number of hours", () => {
    expect(windowFromStored({ ...row, durationLocked: false })).toBeNull();
    expect(windowFromStored({ ...row, returnAt: "2026-10-13T07:30:00Z" })).toBeNull();
    expect(windowFromStored({ ...row, departAt: null })).toBeNull();
  });
  it("the summary names the hours and the window", () => {
    const summary = windowSummary({ ...row });
    expect(summary).toContain(he.requestSentence.window.hours.replace("{{n}}", "4"));
    expect(windowSummary({ ...row, durationLocked: false })).toBeNull();
  });
});

describe("windowHoursLabel", () => {
  it("uses the singular and dual forms", () => {
    expect(windowHoursLabel(1)).toBe(he.requestSentence.window.hour);
    expect(windowHoursLabel(2)).toBe(he.requestSentence.window.twoHours);
    expect(windowHoursLabel(5)).toBe(he.requestSentence.window.hours.replace("{{n}}", "5"));
  });
});

describe("windowFormFields", () => {
  it("opens a stored window request in window mode and an ordinary one in nothing", async () => {
    const { windowFormFields } = await import("./timeWindow");
    expect(windowFormFields({ durationLocked: true, departAt: "2026-10-13T04:00:00Z", returnAt: "2026-10-13T08:00:00Z", flexReturnLate: "01:00:00" }).timeMode).toBe("window");
    expect(windowFormFields({ durationLocked: false, departAt: "2026-10-13T04:00:00Z", returnAt: "2026-10-13T08:00:00Z" })).toEqual({});
  });
});
