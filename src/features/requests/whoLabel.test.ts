import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { whoText } from "./whoLabel";

describe("whoText (R11U3)", () => {
  const me = he.requestSentence.me;
  it("names a noun after the count of unnamed adults", () => {
    expect(whoText([me, "דנה"], 2, 0)).toBe(`${me}, דנה ועוד 2 מבוגרים`);
  });
  it("uses the singular for one unnamed adult", () => {
    expect(whoText([me], 1, 0)).toBe(`${me} ועוד מבוגר/ת`);
  });
  it("joins unnamed adults and children", () => {
    expect(whoText([me, "יהלי מלכה"], 2, 2)).toBe(`${me}, יהלי מלכה ועוד 2 מבוגרים ו־2 ילדים`);
  });
  it("is just the names without extras and just the tail without names", () => {
    expect(whoText(["א", "ב"], 0, 0)).toBe("א וב");
    expect(whoText([], 0, 2)).toBe("2 ילדים");
  });
});
