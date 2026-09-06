import { describe, expect, it } from "vitest";

import { isToday } from "./WeekStrip";

describe("isToday", () => {
  it("is true only for the given 'today' reference", () => {
    expect(isToday("2026-09-06", "2026-09-06")).toBe(true);
    expect(isToday("2026-09-07", "2026-09-06")).toBe(false);
    expect(isToday("2026-09-05", "2026-09-06")).toBe(false);
  });
});
