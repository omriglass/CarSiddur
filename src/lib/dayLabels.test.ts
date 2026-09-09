import { describe, expect, it } from "vitest";

import { weekdayLabel } from "./dayLabels";

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
