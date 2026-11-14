import { describe, expect, it } from "vitest";

import { freedCarOutcomeLine, joinFreedNames } from "./freedCarPreview";

describe("joinFreedNames", () => {
  it("joins with ו־ or או", () => {
    expect(joinFreedNames(["דנה"], "and")).toBe("דנה");
    expect(joinFreedNames(["דנה", "רון"], "and")).toBe("דנה ו־רון");
    expect(joinFreedNames(["דנה", "רון", "יעל"], "or")).toBe("דנה, רון או יעל");
    expect(joinFreedNames(["דנה", "דנה", " "], "or")).toBe("דנה");
  });
});

describe("freedCarOutcomeLine (owner wording 2026-11-14)", () => {
  it("one person gets the car", () => {
    expect(freedCarOutcomeLine({ kind: "auto", requestId: "r", name: "דנה" })).toBe("בעקבות השינוי דנה יקבל/תקבל את הרכב בשעות האלה. תודה!");
  });
  it("a discussion", () => {
    expect(freedCarOutcomeLine({ kind: "group", requestIds: ["a", "b"], names: ["דנה", "רון"] })).toBe("דנה ו־רון ייכנסו לדיון על הרכב. תודה!");
  });
  it("the Sadran decides", () => {
    expect(freedCarOutcomeLine({ kind: "sadran", requestIds: ["a", "b"], names: ["דנה", "רון"] }))
      .toBe("בעקבות השינוי, דנה או רון יקבלו את הרכב, בהתייעצות עם הסדרן/ית. תודה!");
    expect(freedCarOutcomeLine({ kind: "sadran", requestIds: ["a"], names: ["דנה"] }))
      .toBe("בעקבות השינוי, דנה יקבל/תקבל את הרכב, בהתייעצות עם הסדרן/ית. תודה!");
  });
  it("nobody waiting: no line", () => {
    expect(freedCarOutcomeLine({ kind: "none" })).toBeNull();
    expect(freedCarOutcomeLine({ kind: "held" })).toBeNull();
  });
});
