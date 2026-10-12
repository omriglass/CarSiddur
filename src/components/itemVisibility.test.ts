import { describe, expect, it } from "vitest";

import { clampItemVisibility, itemVisibilityStyle } from "./itemVisibility";

describe("itemVisibilityStyle (calendar visibility aid)", () => {
  it("50 is the normal look", () => {
    expect(itemVisibilityStyle(50)).toEqual({ fade: undefined, backing: 0 });
    expect(itemVisibilityStyle(undefined)).toEqual({ fade: undefined, backing: 0 });
  });

  it("below 50 fades every item, down to 20% at 0", () => {
    expect(itemVisibilityStyle(0)).toEqual({ fade: 0.2, backing: 0 });
    expect(itemVisibilityStyle(25).fade).toBeCloseTo(0.6);
  });

  it("above 50 backs the see-through items, solid at 100", () => {
    expect(itemVisibilityStyle(75)).toEqual({ fade: undefined, backing: 0.5 });
    expect(itemVisibilityStyle(100)).toEqual({ fade: undefined, backing: 1 });
  });

  it("clamps garbage to the range / default", () => {
    expect(clampItemVisibility(140)).toBe(100);
    expect(clampItemVisibility(-3)).toBe(0);
    expect(clampItemVisibility("x")).toBe(50);
  });
});
