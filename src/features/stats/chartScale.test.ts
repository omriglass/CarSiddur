import { describe, expect, it } from "vitest";

import { barHeightFraction, niceYAxisTicks, percentTicks } from "./chartScale";

describe("niceYAxisTicks", () => {
  it("returns [0] when there is no data", () => {
    expect(niceYAxisTicks(0)).toEqual([0]);
    expect(niceYAxisTicks(-3)).toEqual([0]);
  });

  it("returns integer ticks starting at 0 and reaching at least maxValue", () => {
    const ticks = niceYAxisTicks(10);
    expect(ticks[0]).toBe(0);
    expect(ticks.every((t) => Number.isInteger(t))).toBe(true);
    expect(ticks.at(-1)!).toBeGreaterThanOrEqual(10);
  });

  it("returns 3 ticks by default", () => {
    expect(niceYAxisTicks(9)).toHaveLength(3);
  });

  it("evenly spaces ticks", () => {
    const ticks = niceYAxisTicks(9);
    const step = ticks[1]! - ticks[0]!;
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBe(step);
    }
  });

  it("handles a max that isn't evenly divisible", () => {
    const ticks = niceYAxisTicks(5);
    expect(ticks.at(-1)!).toBeGreaterThanOrEqual(5);
  });
});

describe("barHeightFraction", () => {
  it("scales a value to 0..1 against the axis max", () => {
    expect(barHeightFraction(5, 10)).toBe(0.5);
    expect(barHeightFraction(10, 10)).toBe(1);
    expect(barHeightFraction(0, 10)).toBe(0);
  });

  it("clamps negative values and overflow to the 0..1 range", () => {
    expect(barHeightFraction(-1, 10)).toBe(0);
    expect(barHeightFraction(15, 10)).toBe(1);
  });

  it("returns 0 when the axis max is 0", () => {
    expect(barHeightFraction(3, 0)).toBe(0);
  });
});

describe("percentTicks", () => {
  it("returns five evenly spaced ticks from 0 to 100 by default", () => {
    expect(percentTicks(false)).toEqual([0, 25, 50, 75, 100]);
  });

  it("thins to three ticks when the chart is narrow", () => {
    expect(percentTicks(true)).toEqual([0, 50, 100]);
  });
});
