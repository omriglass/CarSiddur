import { describe, expect, it } from "vitest";

import { clampItemVisibility, itemVisibilityStyle } from "./itemVisibility";

describe("itemVisibilityStyle (calendar visibility aid, same for rides and requests)", () => {
  it("the middle is the normal look: a 60% backing, no fade", () => {
    expect(itemVisibilityStyle(50)).toEqual({ fade: 1, backing: 0.6 });
    expect(itemVisibilityStyle(undefined)).toEqual({ fade: 1, backing: 0.6 });
  });

  it("towards see-through: the backing thins and the whole block fades, to 40% at 0", () => {
    expect(itemVisibilityStyle(0)).toEqual({ fade: 0.4, backing: 0 });
    const quarter = itemVisibilityStyle(25);
    expect(quarter.fade).toBeCloseTo(0.7);
    expect(quarter.backing).toBeCloseTo(0.3);
  });

  it("towards solid: the backing grows to fully opaque", () => {
    expect(itemVisibilityStyle(75).backing).toBeCloseTo(0.8);
    expect(itemVisibilityStyle(100)).toEqual({ fade: 1, backing: 1 });
  });

  it("clamps garbage to the range / default", () => {
    expect(clampItemVisibility(140)).toBe(100);
    expect(clampItemVisibility(-3)).toBe(0);
    expect(clampItemVisibility("x")).toBe(50);
  });
});
