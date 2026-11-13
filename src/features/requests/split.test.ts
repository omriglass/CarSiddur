import { describe, expect, it } from "vitest";

import { seriesDays, seriesFirstDay, splitCuts, splitParts } from "./split";

describe("split a multi-day ride (SP1)", () => {
  it("lists the series' days from its first day", () => {
    expect(seriesDays("2026-11-16", 3)).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(seriesFirstDay("2026-11-18", 3)).toBe("2026-11-16");
  });

  it("cuts in two or after every day", () => {
    expect(splitCuts("two", 5, 2)).toEqual([2]);
    expect(splitCuts("two", 5, 5)).toEqual([]);
    expect(splitCuts("daily", 4, 0)).toEqual([1, 2, 3]);
    expect(splitCuts("daily", 1, 0)).toEqual([]);
  });

  it("previews the parts", () => {
    const days = seriesDays("2026-11-16", 5);
    expect(splitParts(days, [2]).map((p) => p.length)).toEqual([2, 3]);
    expect(splitParts(days, [1, 2, 3, 4]).map((p) => p.length)).toEqual([1, 1, 1, 1, 1]);
  });
});
