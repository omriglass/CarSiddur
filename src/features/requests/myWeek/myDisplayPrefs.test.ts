import { describe, expect, it } from "vitest";

import { DEFAULT_MY_DISPLAY_PREFS, parseMyDisplayPrefs } from "./myDisplayPrefs";

describe("parseMyDisplayPrefs", () => {
  it("falls back to the list without kids' rides for nothing or garbage", () => {
    expect(parseMyDisplayPrefs(null)).toEqual(DEFAULT_MY_DISPLAY_PREFS);
    expect(parseMyDisplayPrefs("not json")).toEqual(DEFAULT_MY_DISPLAY_PREFS);
    expect(parseMyDisplayPrefs("null")).toEqual(DEFAULT_MY_DISPLAY_PREFS);
  });
  it("reads a saved choice and ignores wrong-typed fields", () => {
    expect(parseMyDisplayPrefs('{"view":"week","showKidsRides":true}')).toEqual({ view: "week", showKidsRides: true });
    expect(parseMyDisplayPrefs('{"view":"grid","showKidsRides":"yes"}')).toEqual(DEFAULT_MY_DISPLAY_PREFS);
  });
});
