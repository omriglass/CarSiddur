import { describe, expect, it } from "vitest";

import { findDominatedIndices, isEmptyConfig } from "./seatConfig";

describe("findDominatedIndices", () => {
  it("flags a row that is entirely covered by a bigger row", () => {
    const rows = [
      { adults: 5, childSeats: 0, boosters: 0 },
      { adults: 3, childSeats: 0, boosters: 0 }, // dominated by row 0
    ];
    expect(findDominatedIndices(rows)).toEqual([1]);
  });

  it("does not flag rows that trade off components (incomparable)", () => {
    const rows = [
      { adults: 5, childSeats: 0, boosters: 0 },
      { adults: 3, childSeats: 1, boosters: 0 }, // fewer adults but a child seat: not dominated
    ];
    expect(findDominatedIndices(rows)).toEqual([]);
  });

  it("keeps only the first of two exact duplicates", () => {
    const rows = [
      { adults: 4, childSeats: 0, boosters: 0 },
      { adults: 4, childSeats: 0, boosters: 0 },
    ];
    expect(findDominatedIndices(rows)).toEqual([1]);
  });

  it("returns no dominated rows for an empty list", () => {
    expect(findDominatedIndices([])).toEqual([]);
  });

  it("flags a strictly-worse row against a preset with several rows", () => {
    const rows = [
      { adults: 7, childSeats: 0, boosters: 0 },
      { adults: 5, childSeats: 2, boosters: 0 },
      { adults: 4, childSeats: 0, boosters: 3 },
      { adults: 2, childSeats: 0, boosters: 0 }, // dominated by row 0
    ];
    expect(findDominatedIndices(rows)).toEqual([3]);
  });
});

describe("isEmptyConfig", () => {
  it("is true only for an all-zero row", () => {
    expect(isEmptyConfig({ adults: 0, childSeats: 0, boosters: 0 })).toBe(true);
    expect(isEmptyConfig({ adults: 1, childSeats: 0, boosters: 0 })).toBe(false);
  });
});
