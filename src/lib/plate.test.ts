import { describe, expect, it } from "vitest";

import { formatPlate } from "./plate";

describe("formatPlate (REQ item 257)", () => {
  it("formats 8 digits as xxx-xx-xxx", () => expect(formatPlate("12345678")).toBe("123-45-678"));
  it("formats 7 digits as xx-xxx-xx", () => expect(formatPlate("1234567")).toBe("12-345-67"));
  it("ignores dashes, spaces and dots already typed", () => {
    expect(formatPlate("12-345-67")).toBe("12-345-67");
    expect(formatPlate("123 45 678")).toBe("123-45-678");
    expect(formatPlate("1234.567")).toBe("12-345-67");
  });
  it("leaves anything else as typed", () => {
    expect(formatPlate("12345")).toBe("12345");
    expect(formatPlate("צ-1234")).toBe("צ-1234");
    expect(formatPlate("  ")).toBe("");
    expect(formatPlate(null)).toBe("");
  });
});
