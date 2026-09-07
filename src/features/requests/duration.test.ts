import { describe, expect, it } from "vitest";

import { endTimeForDuration } from "./duration";

describe("endTimeForDuration", () => {
  it("adds whole hours within the same day", () => {
    expect(endTimeForDuration("08:00", 1)).toEqual({ time: "09:00", nextDay: false });
    expect(endTimeForDuration("08:00", 4)).toEqual({ time: "12:00", nextDay: false });
    expect(endTimeForDuration("14:15", 3)).toEqual({ time: "17:15", nextDay: false });
  });

  it("flags a midnight rollover and wraps the time", () => {
    expect(endTimeForDuration("22:00", 3)).toEqual({ time: "01:00", nextDay: true });
    expect(endTimeForDuration("23:45", 1)).toEqual({ time: "00:45", nextDay: true });
  });

  it("does not roll over when the sum lands exactly on midnight boundary going forward from earlier", () => {
    expect(endTimeForDuration("20:00", 4)).toEqual({ time: "00:00", nextDay: true });
  });
});
