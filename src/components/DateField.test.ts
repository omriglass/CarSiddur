import { describe, expect, it } from "vitest";

import { formatWeekRangeLabel } from "./DateField";

describe("formatWeekRangeLabel", () => {
  it("includes the month on both ends of an RTL week range", () => {
    expect(formatWeekRangeLabel("2026-09-06")).toBe("6.9 – 12.9");
  });
});
