import { describe, expect, it } from "vitest";

import { CAR_NOW_HOURS_OPTIONS, carNowWindow, roundUpTo15 } from "./carNow";

describe("roundUpTo15", () => {
  it("rounds up to the next quarter hour", () => {
    expect(roundUpTo15(new Date("2026-09-10T10:01:00+03:00")).toISOString()).toBe(
      new Date("2026-09-10T10:15:00+03:00").toISOString(),
    );
  });

  it("leaves an already-aligned instant unchanged", () => {
    const aligned = new Date("2026-09-10T10:15:00+03:00");
    expect(roundUpTo15(aligned).toISOString()).toBe(aligned.toISOString());
  });
});

describe("carNowWindow", () => {
  it("presets today, now-rounded-up, and departTime + hours", () => {
    const now = new Date("2026-09-10T10:01:00+03:00"); // Thursday
    expect(carNowWindow(now, 2)).toEqual({ day: "2026-09-10", departTime: "10:15", returnTime: "12:15" });
  });

  it("caps a late departure's return at 23:59 instead of rolling into the next day", () => {
    const now = new Date("2026-09-10T22:50:00+03:00");
    expect(carNowWindow(now, 3)).toEqual({ day: "2026-09-10", departTime: "23:00", returnTime: "23:59" });
  });

  it("offers whole hours 1 through 12", () => {
    expect(CAR_NOW_HOURS_OPTIONS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});
