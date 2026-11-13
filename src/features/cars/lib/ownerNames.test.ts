import { describe, expect, it } from "vitest";

import { tv } from "@/i18n/he";

import { joinNames } from "./ownerNames";

describe("joinNames (PC1)", () => {
  it("one, two and three names; blanks and repeats dropped", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["A", " ", "A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe(tv("carPage.namesLast", { rest: "A", last: "B" }));
    expect(joinNames(["A", "B", "C"])).toBe(tv("carPage.namesLast", { rest: "A, B", last: "C" }));
  });
});
