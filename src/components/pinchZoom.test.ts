import { describe, expect, it } from "vitest";

import { nextZoom, zoomIn, zoomOut } from "./pinchZoom";

describe("nextZoom", () => {
  it("scales proportionally to the finger-distance ratio", () => {
    expect(nextZoom(1, 100, 150)).toBeCloseTo(1.5, 5);
    expect(nextZoom(1, 100, 50)).toBeCloseTo(0.5, 5);
    expect(nextZoom(1, 200, 200)).toBeCloseTo(1, 5);
  });

  it("clamps to 1.5 at the top; one pinch from above 0.4 stops at 0.4 (soft floor)", () => {
    expect(nextZoom(1, 100, 1000)).toBe(1.5);
    expect(nextZoom(1, 100, 1)).toBe(0.4);
    expect(nextZoom(1.5, 100, 10)).toBe(0.4);
  });

  it("a pinch that starts at or below 0.4 may go on down to 0.2 (hard floor)", () => {
    expect(nextZoom(0.4, 100, 50)).toBe(0.2);
    expect(nextZoom(0.4, 100, 75)).toBe(0.3);
    expect(nextZoom(0.3, 100, 1)).toBe(0.2);
  });

  it("the − / + buttons step by 0.1 between 0.2 and 1.5", () => {
    expect(zoomOut(0.5)).toBe(0.4);
    expect(zoomOut(0.3)).toBe(0.2);
    expect(zoomOut(0.2)).toBe(0.2);
    expect(zoomIn(1.5)).toBe(1.5);
    expect(zoomIn(0.2)).toBe(0.3);
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
