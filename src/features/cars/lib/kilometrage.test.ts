import { describe, expect, it } from "vitest";

import { formatKm, MAX_KM, parseKm } from "./kilometrage";

describe("parseKm", () => {
  it("accepts whole numbers with optional separators", () => {
    expect(parseKm("123456")).toBe(123456);
    expect(parseKm(" 123,456 ")).toBe(123456);
    expect(parseKm("0")).toBe(0);
  });

  it("rejects empty, decimal, negative, text and too-large input", () => {
    for (const bad of ["", "  ", "12.5", "-3", "abc", "12a", "99999999"]) expect(parseKm(bad)).toBeNull();
    expect(parseKm(String(MAX_KM))).toBe(MAX_KM);
  });
});

describe("formatKm", () => {
  it("groups thousands", () => {
    expect(formatKm(1234567)).toBe("1,234,567");
    expect(formatKm(87)).toBe("87");
  });
});
