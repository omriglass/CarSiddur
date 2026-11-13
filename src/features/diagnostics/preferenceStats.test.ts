import { describe, expect, it } from "vitest";

import { asCounts, asNumber } from "./preferenceStats";

describe("preference stats readers (AN1)", () => {
  it("reads numbers and count maps defensively", () => {
    expect(asNumber(3)).toBe(3);
    expect(asNumber("3")).toBe(0);
    expect(asCounts({ neutral: 2, fun: 5, odd: "x" })).toEqual([["fun", 5], ["neutral", 2], ["odd", 0]]);
    expect(asCounts(null)).toEqual([]);
    expect(asCounts([1])).toEqual([]);
  });
});
