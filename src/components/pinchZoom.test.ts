import { describe, expect, it } from "vitest";

import { nextZoom } from "./pinchZoom";

describe("nextZoom", () => {
  it("scales proportionally to the finger-distance ratio", () => {
    expect(nextZoom(1, 100, 150)).toBeCloseTo(1.5, 5);
    expect(nextZoom(1, 100, 50)).toBeCloseTo(0.5, 5);
    expect(nextZoom(1, 200, 200)).toBeCloseTo(1, 5);
  });

  it("clamps to the 0.5–1.5 range", () => {
    expect(nextZoom(1, 100, 1000)).toBe(1.5);
    expect(nextZoom(1, 100, 1)).toBe(0.5);
  });

  it("rounds to the nearest 0.05 step", () => {
    expect(nextZoom(1, 100, 107)).toBe(1.05);
    expect(nextZoom(1, 100, 103)).toBe(1.05);
    expect(nextZoom(1, 100, 112)).toBe(1.1);
  });

  it("returns the starting zoom unchanged when the start distance is degenerate", () => {
    expect(nextZoom(1.2, 0, 50)).toBe(1.2);
    expect(nextZoom(0.8, -5, 50)).toBe(0.8);
  });
});
