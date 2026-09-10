import { describe, expect, it } from "vitest";

import { pieSegments } from "./pieMath";

describe("pieSegments", () => {
  it("splits values into consecutive fractions summing to 1", () => {
    const segments = pieSegments([80, 20]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ start: 0, end: 0.8, fraction: 0.8 });
    expect(segments[1]).toEqual({ start: 0.8, end: 1, fraction: 0.2 });
  });

  it("returns one full-circle segment for a single value", () => {
    expect(pieSegments([42])).toEqual([{ start: 0, end: 1, fraction: 1 }]);
  });

  it("returns an empty array when every value is zero", () => {
    expect(pieSegments([0, 0, 0])).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(pieSegments([])).toEqual([]);
  });

  it("ignores negative values as zero instead of producing a negative fraction", () => {
    const segments = pieSegments([10, -5, 10]);
    expect(segments.reduce((sum, s) => sum + s.fraction, 0)).toBeCloseTo(1);
    expect(segments[1]!.fraction).toBe(0);
  });

  it("sums fractions to exactly 1 across many values", () => {
    const segments = pieSegments([1, 2, 3, 4, 5, 6, 7]);
    const total = segments.reduce((sum, s) => sum + s.fraction, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(segments.at(-1)!.end).toBeCloseTo(1, 10);
  });
});
