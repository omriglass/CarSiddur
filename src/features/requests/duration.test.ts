import { describe, expect, it } from "vitest";

import { endTimeForDuration, shiftReturnByDepartureDelta } from "./duration";

describe("endTimeForDuration", () => {
  it("adds whole hours within the same day", () => {
    expect(endTimeForDuration("08:00", 1)).toEqual({ time: "09:00", nextDay: false });
    expect(endTimeForDuration("08:00", 4)).toEqual({ time: "12:00", nextDay: false });
    expect(endTimeForDuration("14:15", 3)).toEqual({ time: "17:15", nextDay: false });
  });

  it("caps durations that would cross midnight at the last minute of the same day", () => {
    expect(endTimeForDuration("22:00", 3)).toEqual({ time: "23:59", nextDay: false });
    expect(endTimeForDuration("23:45", 1)).toEqual({ time: "23:59", nextDay: false });
  });

  it("caps an exact midnight end at 23:59", () => {
    expect(endTimeForDuration("20:00", 4)).toEqual({ time: "23:59", nextDay: false });
  });
});

describe("shiftReturnByDepartureDelta", () => {
  it("shifts the return time forward by the same delta as the departure", () => {
    expect(shiftReturnByDepartureDelta("08:00", "09:00", "12:00")).toBe("13:00");
  });

  it("shifts the return time backward when the departure moves earlier", () => {
    expect(shiftReturnByDepartureDelta("09:00", "08:00", "13:00")).toBe("12:00");
  });

  it("does nothing when there is no return time to shift", () => {
    expect(shiftReturnByDepartureDelta("08:00", "09:00", undefined)).toBeUndefined();
  });

  it("does nothing when the departure time is unchanged", () => {
    expect(shiftReturnByDepartureDelta("08:00", "08:00", "12:00")).toBe("12:00");
  });

  it("clamps the shift at the day's last minute", () => {
    expect(shiftReturnByDepartureDelta("22:00", "23:45", "23:59")).toBe("23:59");
  });

  it("clamps the shift at the day's first minute", () => {
    expect(shiftReturnByDepartureDelta("08:00", "06:00", "00:15")).toBe("00:00");
  });

  it("preserves the special 23:59 same-day-end literal as a shift source", () => {
    expect(shiftReturnByDepartureDelta("20:00", "21:00", "23:59")).toBe("23:59");
  });
});
