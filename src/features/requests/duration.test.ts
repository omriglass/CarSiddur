import { describe, expect, it } from "vitest";

import { endTimeForDuration } from "./duration";

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
