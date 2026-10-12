import { describe, expect, it } from "vitest";

import { isRideDayEditable } from "./rideDayEditable";

describe("isRideDayEditable", () => {
  const now = new Date("2026-10-12T15:00:00+03:00");
  it("keeps a started ride of today editable", () => {
    expect(isRideDayEditable("2026-10-12T06:00:00+03:00", now)).toBe(true);
  });
  it("allows later days", () => {
    expect(isRideDayEditable("2026-10-13T06:00:00+03:00", now)).toBe(true);
  });
  it("refuses yesterday", () => {
    expect(isRideDayEditable("2026-10-11T23:00:00+03:00", now)).toBe(false);
  });
  it("uses the Jerusalem date, not UTC", () => {
    // 00:30 Jerusalem on the 13th is still the 12th in UTC.
    expect(isRideDayEditable("2026-10-13T00:30:00+03:00", new Date("2026-10-12T21:30:00Z"))).toBe(true);
    expect(isRideDayEditable("2026-10-12T23:00:00+03:00", new Date("2026-10-12T21:30:00Z"))).toBe(false);
  });
  it("is false without a start", () => {
    expect(isRideDayEditable(null, now)).toBe(false);
  });
});
