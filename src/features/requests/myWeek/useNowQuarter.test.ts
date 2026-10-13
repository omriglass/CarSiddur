import { describe, expect, it } from "vitest";

import { quarterOf } from "./useNowQuarter";

describe("quarterOf", () => {
  it("is the Jerusalem quarter hour now falls in (owner 2026-10-13: 07:58 → 07:45, 08:01 → 08:00)", () => {
    expect(quarterOf(new Date("2026-10-13T07:58:00+03:00"))).toBe(7 * 60 + 45);
    expect(quarterOf(new Date("2026-10-13T08:01:00+03:00"))).toBe(8 * 60);
    expect(quarterOf(new Date("2026-10-13T08:00:00+03:00"))).toBe(8 * 60);
  });
});
