import { describe, expect, it } from "vitest";
import { innerWidthCss, isIdentityZoom, outerWidthCss, scaledBoxStyles, scaledHeight } from "./weekGridScale";

describe("weekGridScale", () => {
  it("treats 1 as identity only", () => {
    expect(isIdentityZoom(1)).toBe(true);
    expect(isIdentityZoom(0.5)).toBe(false);
    expect(isIdentityZoom(1.5)).toBe(false);
  });

  it("scales the visible height and minimum width, at 0.5 / 1 / 1.5", () => {
    expect(scaledHeight(0.5, 1440)).toBe(720);
    expect(scaledHeight(1, 1440)).toBe(1440);
    expect(scaledHeight(1.5, 1440)).toBe(2160);
    expect(outerWidthCss(0.5, 804)).toBe("max(100%, 402px)");
    expect(outerWidthCss(1.5, 804)).toBe("max(100%, 1206px)");
  });

  it("lays the inner grid out wide enough that its scaled width fills the viewport", () => {
    expect(innerWidthCss(0.5, 804)).toBe("max(804px, calc(100% / 0.5))");
    expect(innerWidthCss(1.5, 804)).toBe("max(804px, calc(100% / 1.5))");
  });

  it("builds a transform from the top-right corner (RTL) with no CSS zoom", () => {
    const { outer, inner } = scaledBoxStyles(0.5, 804, 1000);
    expect(outer.height).toBe(500);
    expect(inner.transform).toBe("scale(0.5)");
    expect(inner.transformOrigin).toBe("top right");
    expect(inner).not.toHaveProperty("zoom");
    expect(outer).not.toHaveProperty("zoom");
  });
});
