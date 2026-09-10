import { describe, expect, it } from "vitest";

import { formatDecimal, formatPercent } from "./format";

describe("formatPercent", () => {
  it("formats a 0..1 rate as a one-decimal percentage", () => {
    expect(formatPercent(0.0628)).toBe("6.3%");
    expect(formatPercent(0.1048)).toBe("10.5%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(1)).toBe("100.0%");
  });
});

describe("formatDecimal", () => {
  it("defaults to one decimal place", () => {
    expect(formatDecimal(123.5)).toBe("123.5");
    expect(formatDecimal(5)).toBe("5.0");
  });

  it("honors an explicit digit count", () => {
    expect(formatDecimal(0.83, 2)).toBe("0.83");
    expect(formatDecimal(0.8, 2)).toBe("0.80");
  });
});
